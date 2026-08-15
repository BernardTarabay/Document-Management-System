// Assembles the dashboard payload.
//
// Everything is fetched in parallel and shaped here rather than in the page,
// so the browser makes ONE request and the numbers all describe the same
// moment. The old dashboard fired five list endpoints and counted the arrays,
// which was both wrong past 200 rows and inconsistent between widgets.
const dashboardRepository = require("../repositories/dashboardRepository");
const { requireOwner } = require("../repositories/ownership");

const num = (v) => Number(v || 0);

async function summary(ownerUserId) {
  requireOwner(ownerUserId, "dashboardService.summary");
  const [overview, attention, reclaimable, extensions, locations, jobs, trend] = await Promise.all([
    dashboardRepository.overview(ownerUserId),
    dashboardRepository.attention(ownerUserId),
    dashboardRepository.reclaimableBytes(ownerUserId),
    dashboardRepository.byExtension(ownerUserId, 10),
    dashboardRepository.byLocation(ownerUserId),
    dashboardRepository.recentJobs(ownerUserId, 24),
    dashboardRepository.ingestionTrend(ownerUserId, 14),
  ]);

  const total = num(overview.total_files);

  return {
    totals: {
      files: total,
      bytes: num(overview.total_bytes),
      missing: num(overview.missing),
      placeholders: num(overview.placeholders),
      searchable: num(overview.searchable),
      named: num(overview.named),
      needsOcr: num(overview.needs_ocr),
    },

    // The pipeline as a funnel. Each stage is a subset of the one above it,
    // so where the number drops is where files are getting stuck -- which is
    // the question a dashboard for this app should answer first.
    funnel: [
      { stage: "Discovered", count: total, hint: "Files the scanner has found" },
      { stage: "Hashed", count: num(overview.hashed), hint: "Fingerprinted, so duplicates can be spotted" },
      { stage: "Text extracted", count: num(overview.extracted), hint: "Read, whether or not the text was usable" },
      { stage: "Searchable", count: num(overview.searchable), hint: "Text good enough to search and classify from" },
      { stage: "Filed", count: num(overview.classified), hint: "Placed under a subject" },
      { stage: "Named", count: num(overview.named), hint: "Given a canonical name" },
    ],

    attention: {
      stalled: num(attention.stalled),
      needsOcr: num(attention.needs_ocr),
      unfiled: num(attention.unfiled),
      pendingProposals: num(attention.pending_proposals),
      zeroConfidenceProposals: num(attention.zero_confidence_proposals),
      openExactDuplicates: num(attention.open_exact_duplicates),
      openProbableDuplicates: num(attention.open_probable_duplicates),
      jobsInFlight: num(attention.jobs_in_flight),
      jobsFailedToday: num(attention.jobs_failed_today),
      reclaimableBytes: num(reclaimable.bytes),
      redundantCopies: num(reclaimable.copies),
    },

    extensions: extensions.map((e) => ({
      ext: e.ext,
      files: num(e.files),
      bytes: num(e.bytes),
      searchable: num(e.searchable),
    })),

    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      rootPath: l.root_path,
      isReadOnly: l.is_read_only,
      files: num(l.files),
      bytes: num(l.bytes),
      named: num(l.named),
      lastScan: l.last_scan,
    })),

    jobs: jobs.map((j) => ({
      type: j.job_type,
      completed: num(j.completed),
      failed: num(j.failed),
      active: num(j.active),
    })),

    trend: trend.map((t) => ({ day: t.day, files: num(t.files) })),
  };
}

module.exports = { summary };
