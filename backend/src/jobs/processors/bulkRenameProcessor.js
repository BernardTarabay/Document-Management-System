// Applies APPROVED rename proposals to physical files (spec §22/§23: bulk
// operations execute only after human approval; every filesystem change is
// audited). A proposal that isn't 'approved' is skipped, not applied --
// this processor is the only place `rename_proposals` become real filesystem
// changes, and it enforces that gate itself rather than trusting the caller.
const path = require("path");
const db = require("../../config/database");
const renameProposalRepository = require("../../repositories/renameProposalRepository");
const fileRepository = require("../../repositories/fileRepository");
const storageLocationRepository = require("../../repositories/storageLocationRepository");
const processingJobItemRepository = require("../../repositories/processingJobItemRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { getStorageServiceFor } = require("../../services/storage/storageService");
const { renameToAvailableName } = require("../../utils/resolveAvailableFilename");
const { enqueueJob } = require("../../queues");
const { JobType } = require("../../models/enums");
const env = require("../../config/env");

async function handle({ proposalIds }, bullJob) {
  const summary = { applied: 0, skipped: 0, failed: 0 };
  let mirrorNeedsSync = false;

  for (const proposalId of proposalIds) {
    const jobItem = await processingJobItemRepository.create({
      jobId: bullJob.data.processingJobId,
      fileId: null,
      status: "pending",
    });

    try {
      const proposal = await renameProposalRepository.findById(proposalId);
      if (!proposal || proposal.status !== "approved") {
        summary.skipped += 1;
        await processingJobItemRepository.complete(jobItem.id, {
          status: "skipped",
          result: { reason: "proposal not in approved status" },
        });
        continue;
      }

      const file = await fileRepository.findById(proposal.file_id);
      const storageLocation = await storageLocationRepository.findById(file.storage_location_id);

      // READ-ONLY LOCATION: record the name this file should have, and
      // touch nothing on disk.
      //
      // These are the owner's real working files -- on iCloud, on external
      // drives, irreplaceable. Renaming or moving one is the only action in
      // this system that can destroy something, and the organized view the
      // user actually browses is the shortcut mirror, which is regenerated
      // from exactly these columns. So there is nothing to gain by writing
      // to the original and everything to lose.
      if (storageLocation.is_read_only) {
        await fileRepository.setCanonicalName(file.id, {
          canonicalFilename: proposal.proposed_filename,
          canonicalRelativeDir: proposal.proposed_relative_dir || null,
        });
        await renameProposalRepository.markApplied(proposalId);

        await auditLogRepository.record({
          action: "file.canonical_name_set",
          entityType: "file",
          entityId: file.id,
          previousState: { filename: file.filename_current, path: file.current_path },
          newState: {
            canonicalFilename: proposal.proposed_filename,
            canonicalRelativeDir: proposal.proposed_relative_dir || null,
          },
          reason:
            `Applied approved proposal ${proposalId} to a read-only location ` +
            `("${storageLocation.name}"). The original file was NOT renamed or moved; ` +
            "the canonical name is used by the shortcut mirror and the UI.",
        });

        summary.applied += 1;
        summary.canonicalOnly = (summary.canonicalOnly || 0) + 1;
        mirrorNeedsSync = true;
        await processingJobItemRepository.complete(jobItem.id, {
          status: "succeeded",
          result: {
            readOnly: true,
            canonicalFilename: proposal.proposed_filename,
            canonicalRelativeDir: proposal.proposed_relative_dir || null,
          },
        });
        continue;
      }

      const storageService = getStorageServiceFor(storageLocation);
      const previousPath = file.current_path;
      const currentDir = path.dirname(file.current_path);
      const targetRelativeDir = proposal.proposed_relative_dir || (currentDir === "." ? null : currentDir);

      const { absolutePath: newAbsolutePath, filename: safeFilename } = await renameToAvailableName(
        storageService,
        file.current_path,
        proposal.proposed_filename,
        // The folder the file will actually END UP in -- the proposal's
        // target if it has one, otherwise the folder it is already in. Both
        // the collision check and the move have to agree on this; passing
        // the proposal's raw (often null) value to one and the resolved
        // directory to the other is what "no path separators" hides.
        targetRelativeDir
      );
      const newRelativePath = path.relative(storageService.rootPath, newAbsolutePath);

      const collided = safeFilename !== proposal.proposed_filename;
      const movedFolder = Boolean(proposal.proposed_relative_dir);
      const actionParts = [];
      if (proposal.current_filename !== safeFilename) actionParts.push("renamed");
      if (movedFolder) actionParts.push(`moved to "${proposal.proposed_relative_dir}"`);

      // THE FILE HAS ALREADY MOVED ON DISK. The database must now agree, or
      // it does not describe reality.
      //
      // These three writes were separately autocommitted, so a crash after
      // the rename left `files.current_path` pointing at a name that no
      // longer exists -- every later read of that file (download, preview,
      // hash, extraction) failing, with the file itself perfectly intact a
      // few bytes away under its new name. The filesystem cannot join a
      // Postgres transaction, but these three can join each other, and if
      // they fail as a group there is exactly one sane response: put the file
      // back where the database still thinks it is.
      try {
        await db.withTransaction(async (client) => {
          await fileRepository.updatePath(
            file.id,
            { currentPath: newRelativePath, filenameCurrent: safeFilename },
            client
          );
          await renameProposalRepository.markApplied(proposalId, client);
          await auditLogRepository.record({
            action: "file.renamed",
            entityType: "file",
            entityId: file.id,
            previousState: { path: previousPath, filename: proposal.current_filename },
            newState: { path: newRelativePath, filename: safeFilename },
            reason:
              `Applied approved proposal ${proposalId} (${actionParts.join(", ") || "no change"})` +
              (collided ? `; "${proposal.proposed_filename}" already existed at the destination, used "${safeFilename}" instead` : ""),
            client,
          });
        });
      } catch (dbErr) {
        // Compensating action: undo the filesystem half so the two halves
        // stay consistent. If even this fails, the file is intact but under
        // the wrong name, so say exactly that -- a message someone can act on
        // beats a generic failure for the one case where a human has to.
        try {
          await storageService.rename(newRelativePath, path.basename(previousPath), path.dirname(previousPath) === "." ? null : path.dirname(previousPath));
          dbErr.message = `${dbErr.message} (the file was renamed back to "${previousPath}")`;
        } catch (revertErr) {
          dbErr.message =
            `${dbErr.message}. The database could not be updated AND the file could not be moved back: ` +
            `it is on disk at "${newRelativePath}" but recorded as "${previousPath}" (${revertErr.message}). ` +
            "A rescan of this storage location will reconcile it.";
        }
        throw dbErr;
      }

      summary.applied += 1;
      await processingJobItemRepository.complete(jobItem.id, {
        status: "succeeded",
        result: { newPath: newRelativePath, moved: movedFolder },
      });
    } catch (err) {
      summary.failed += 1;
      await processingJobItemRepository.complete(jobItem.id, {
        status: "failed",
        errorMessage: err.message,
      });
    }
  }

  // A canonical name only becomes visible to the user once the shortcut
  // exists, so applying one has to trigger a mirror rebuild -- otherwise
  // approving a rename appears to do nothing at all. Skipped entirely when
  // no mirror is configured, and enqueued once for the whole batch rather
  // than once per file.
  if (mirrorNeedsSync && env.mirrorRoot) {
    try {
      await enqueueJob(JobType.SYNC_MIRROR, {}, {});
    } catch (err) {
      // The renames themselves succeeded; a failed mirror enqueue must not
      // report the whole job as failed. The next sync picks these up.
      summary.mirrorSyncError = err.message;
    }
  }

  return summary;
}

module.exports = { handle };
