const fileService = require("../services/fileService");
const mime = require("../utils/mimeGuess");
const { buildContentDisposition } = require("../utils/contentDisposition");

async function list(req, res) {
  res.json(await fileService.search(req.query, req.user.id));
}

async function count(req, res) {
  res.json(await fileService.count(req.query, req.user.id));
}

async function filterOptions(req, res) {
  res.json(await fileService.filterOptions(req.user.id));
}

async function getOne(req, res) {
  res.json(await fileService.getFileDetail(req.params.id, req.user.id));
}

async function download(req, res) {
  const { file, stream } = await fileService.getDownloadStream(req.params.id, req.user.id);
  await fileService.recordDownloadAudit(file.id, req.user.id);

  res.setHeader("Content-Type", mime.guessMimeType(file.extension, file.mime_type_detected));
  res.setHeader("Content-Disposition", buildContentDisposition("attachment", file.filename_current));
  // The bytes are whatever the user's own document contains and the type is
  // guessed from its extension, so forbid the browser from sniffing its way
  // to a different, more executable opinion. `attachment` above already means
  // it is saved rather than rendered; this closes the gap for the browsers
  // that sniff anyway.
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Close the file handle when the client goes away.
  //
  // Without this, a cancelled download -- the user hitting Escape, closing the
  // tab, or a flaky connection on a multi-gigabyte file -- left the read
  // stream open with nothing draining it. On a corpus of hundreds of GB that
  // is a file descriptor and its buffers held until the process exits, once
  // per abandoned download.
  res.on("close", () => stream.destroy());

  stream.on("error", (err) => {
    // Once piping has begun the status line is already on the wire, so
    // res.status(500) here did nothing except throw ERR_HTTP_HEADERS_SENT
    // inside an error handler. Destroying the response is the only honest
    // signal left: it aborts the transfer so the client sees a truncated
    // download rather than a silently short file it believes is complete.
    console.error(`[download] stream failed for file ${file.id}:`, err.message);
    if (res.headersSent) res.destroy(err);
    else res.status(500).json({ error: "Could not read the file from disk." });
  });

  stream.pipe(res);
}

async function preview(req, res) {
  const { file, contentType, buffer } = await fileService.getPreviewImage(req.params.id, req.user.id);

  res.setHeader("Content-Type", contentType);
  // inline (not attachment) so the browser renders it -- always safe here
  // regardless of the underlying file's real format, since getPreviewImage
  // never returns raw bytes for anything but an actual raster image; every
  // other format has already been rasterized to a flat PNG.
  res.setHeader("Content-Disposition", buildContentDisposition("inline", `${file.filename_current}.preview.png`));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(buffer);
}

async function remove(req, res) {
  res.json(await fileService.removeFile(req.params.id, req.user.id));
}

async function removeAll(req, res) {
  const job = await fileService.removeAllFiles(req.user.id);
  res.status(202).json({ processingJobId: job.id, status: job.status });
}

// Filename and subject/documentType are separately permissioned -- reject
// up front rather than letting the service silently apply only part of
// what was asked, which would be confusing ("I set both fields but only
// the name changed and I don't know why").
async function update(req, res) {
  const { filename, subjectId, documentTypeId, confirmDuplicate } = req.body || {};

  if (filename !== undefined && !req.user.permissions.includes("document.rename")) {
    return res.status(403).json({ error: "Missing required permission: document.rename" });
  }
  if ((subjectId !== undefined || documentTypeId !== undefined) && !req.user.permissions.includes("classification.modify")) {
    return res.status(403).json({ error: "Missing required permission: classification.modify" });
  }

  const result = await fileService.updateFile(
    req.params.id,
    { filename, subjectId, documentTypeId, confirmDuplicate: Boolean(confirmDuplicate) },
    req.user.id
  );

  // 409 when the duplicate guard found something worth interrupting for. Not
  // an error to swallow: the body carries the findings and the actions
  // available on each, and the UI walks the user through them before calling
  // back with confirmDuplicate.
  res.status(result?.requiresConfirmation ? 409 : 200).json(result);
}

async function reveal(req, res) {
  res.json(await fileService.revealInFileManager(req.params.id, req.user.id));
}

async function compare(req, res) {
  const { fileIdA, fileIdB } = req.body || {};
  res.json(await fileService.compareFiles(fileIdA, fileIdB, req.user.id));
}

module.exports = {
  list, count, filterOptions, getOne, download, preview, remove, removeAll, compare, update, reveal,
};
