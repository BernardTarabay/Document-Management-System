import { useMemo, useState, useEffect, useRef } from "react";
import {
  FolderTree, ChevronRight, FileText, Plus, Pencil, Trash2,
  Eye, Download, FolderInput, Sparkles, Search, X, ListTree, Network,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { FileDetailModal } from "../components/FileDetailModal";
import { PreviewModal } from "../components/PreviewModal";
import { EditFileModal } from "../components/EditFileModal";
import { MoveFileModal } from "../components/MoveFileModal";
// FolderImportZone removed alongside FolderUploadZone: both uploaded file
// BYTES into backend/storage/uploads. Folders are registered and indexed in
// place now -- see StorageLocationsPage.
import { FileFilters, EMPTY_FILTERS, filtersToParams, countActiveFilters } from "../components/FileFilters";
import { DocumentDateInline, LocationLabel } from "../components/DocumentDate";
import { usePublishAssistantContext, useAssistantChanges, useAssistantReveal } from "../context/AssistantContext";
import { SearchSnippet, MatchReason } from "../components/SearchSnippet";
import { SubjectGraph } from "../components/SubjectGraph";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";

const FILES_LIMIT = 20;

export function SubjectsPage() {
  const { hasPermission } = useAuth();
  const { push } = useToast();
  const canManage = hasPermission("subject.manage");

  // Filters apply to the whole page: the counts drawn on the tree AND the
  // file list inside whichever subject is open. A tree whose numbers ignored
  // the filter would be advertising files the panel below then refuses to
  // show. There is deliberately no SUBJECT filter here -- the tree is the
  // subject picker, and a dropdown duplicating it would be a second, quieter
  // way to disagree with what is selected.
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const filterParams = filtersToParams(filters);
  const filterKey = JSON.stringify(filterParams);
  const activeFilters = countActiveFilters(filters);

  const { data: subjects, loading, error: subjectsError, reload: reloadSubjects } = useApiData(
    () => api.get("/subjects", filterParams),
    [filterKey]
  );
  const [selectedId, setSelectedId] = useState(null);
  const [fileOffset, setFileOffset] = useState(0);

  // Filter-as-you-type over the taxonomy itself. On a deep tree this is the
  // difference between scanning dozens of branches and typing three letters.
  const [treeFilter, setTreeFilter] = useState("");

  // List vs roadmap graph. Remembered, because whichever one someone
  // prefers, they prefer it every time -- resetting to the default on each
  // visit would make the toggle feel like it did not work.
  const [view, setView] = useState(() => localStorage.getItem("atlas.subjectView") || "list");
  function changeView(next) {
    setView(next);
    localStorage.setItem("atlas.subjectView", next);
  }

  // Searching the map should find FILES, not just subject names. Typing an
  // invoice number into a taxonomy filter and getting "no subject matches"
  // is a true answer to a question nobody asked -- the thing being looked
  // for is a document, and its subject is only how you get to it.
  //
  // Debounced, and only in graph view: the list view already has its own
  // per-subject file search, and firing a full-text query on every keystroke
  // in both would double the load for no benefit.
  const [fileMatches, setFileMatches] = useState([]);
  useEffect(() => {
    const term = treeFilter.trim();
    if (view !== "graph" || term.length < 2) {
      setFileMatches([]);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      // GET /files, not GET /files/search -- the latter was never a route, so
      // it fell through to GET /files/:id, failed the uuid cast with 400
      // "Malformed id", and the catch below swallowed it. The map's file
      // search has therefore always lit up nothing at all.
      api
        .get("/files", { q: term, limit: 40, ...filterParams })
        .then((rows) => { if (!cancelled) setFileMatches(rows || []); })
        .catch(() => { if (!cancelled) setFileMatches([]); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
    // filterKey is the stable serialization of filterParams -- it changes
    // exactly when the filters do, which an object identity would not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeFilter, view, filterKey]);

  // The subjects those files live under -- what the map lights up.
  const matchedSubjectIds = useMemo(
    () => new Set(fileMatches.map((f) => f.subject_id).filter(Boolean)),
    [fileMatches]
  );

  // "Show me where this lives", asked by the assistant after it found a file.
  // Switching to the map is part of the answer: the route lighting up IS the
  // answer, and it cannot be seen from the list view.
  useAssistantReveal((subjectId) => {
    if (!subjectId) return;
    changeView("graph");
    setSelectedId(subjectId);
  });

  const tree = useMemo(() => buildTree(subjects || []), [subjects]);
  const visibleTree = useMemo(() => filterTree(tree, treeFilter), [tree, treeFilter]);
  const selected = useMemo(
    () => (subjects || []).find((s) => s.id === selectedId) || null,
    [subjects, selectedId]
  );

  // Subject create/rename/delete state.
  const [formTarget, setFormTarget] = useState(null); // { mode: 'create'|'edit', parentId?, subject? }
  const [deleteSubjectTarget, setDeleteSubjectTarget] = useState(null);
  const [deletingSubject, setDeletingSubject] = useState(false);

  // File action state -- same shape as FilesPage, reusing the same modals.
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [previewFileId, setPreviewFileId] = useState(null);
  const [editFileTarget, setEditFileTarget] = useState(null);
  const [moveFileTarget, setMoveFileTarget] = useState(null);
  const [removeFileTarget, setRemoveFileTarget] = useState(null);
  const [removingFile, setRemovingFile] = useState(false);

  const detailPanelRef = useRef(null);

  useEffect(() => setFileOffset(0), [selectedId]);

  // On narrow screens the two columns stack, so the file panel sits BELOW
  // the whole tree and selecting a subject appears to do nothing until you
  // scroll. Sticky positioning only applies at lg and up, so bring the
  // panel into view here instead. Guarded on the breakpoint so this never
  // fights the sticky behaviour on a wide screen.
  useEffect(() => {
    if (!selectedId || !detailPanelRef.current) return;
    const isStacked = window.matchMedia("(max-width: 1023px)").matches;
    if (isStacked) {
      detailPanelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedId]);

  // Search WITHIN the selected subject. Debounced so typing doesn't fire a
  // request per keystroke; reset to page 1 whenever the term changes, or
  // you end up on page 3 of a result set with one page.
  const [fileQuery, setFileQuery] = useState("");
  const [debouncedFileQuery, setDebouncedFileQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedFileQuery(fileQuery); setFileOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [fileQuery]);
  useEffect(() => { setFileQuery(""); setDebouncedFileQuery(""); }, [selectedId]);

  const { data: documents, loading: loadingDocs, reload: reloadFiles } = useApiData(
    () =>
      selected
        ? api.get(`/subjects/${selected.id}/documents`, {
            limit: FILES_LIMIT,
            offset: fileOffset,
            q: debouncedFileQuery || undefined,
            ...filterParams,
          })
        : Promise.resolve(null),
    [selected?.id, fileOffset, debouncedFileQuery, filterKey]
  );

  // Tell the assistant what is on screen so "move this file" resolves.
  usePublishAssistantContext({
    page: "Subjects",
    description: selected
      ? `Viewing the subject "${selected.name}" (${selected.materialized_path}); the listed files are the ones classified under it.`
      : "Browsing the subject taxonomy; no subject is selected, so no files are visible.",
    files: documents || [],
    selectedSubjectId: selected?.id || null,
  });

  // Reload after the assistant applies something, since it changes the same
  // data this page is showing.
  useAssistantChanges(() => { reloadSubjects(); reloadFiles(); });

  async function downloadFile(id, filename) {
    try {
      await api.download(`/files/${id}/download`, filename);
    } catch (err) {
      push(err.message, "error");
    }
  }

  async function confirmRemoveFile() {
    if (!removeFileTarget) return;
    setRemovingFile(true);
    try {
      await api.del(`/files/${removeFileTarget.id}`);
      push(`"${removeFileTarget.display_name || removeFileTarget.filename_current}" removed.`, "success");
      setRemoveFileTarget(null);
      reloadFiles();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setRemovingFile(false);
    }
  }

  /**
   * Dropping a file onto a subject node reclassifies it.
   *
   * This writes a manual classification, exactly as the Edit dialog's
   * subject dropdown does -- it is the same operation, reached faster. It
   * does NOT move or rename anything on disk; on a read-only location
   * nothing there ever changes, and the new subject shows up in the mirror
   * the next time it syncs.
   */
  async function reclassifyByDrop(fileId, targetSubject) {
    if (!hasPermission("classification.modify")) {
      push("You don't have permission to reclassify files.", "error");
      return;
    }
    if (targetSubject.id === selectedId) return; // already there

    try {
      await api.patch(`/files/${fileId}`, { subjectId: targetSubject.id });
      push(`Moved to ${targetSubject.name}.`, "success");
      reloadFiles();
      reloadSubjects(); // counts on both the old and new subject changed
    } catch (err) {
      push(err.message, "error");
    }
  }

  async function confirmDeleteSubject() {
    if (!deleteSubjectTarget) return;
    setDeletingSubject(true);
    try {
      await api.del(`/subjects/${deleteSubjectTarget.id}`);
      push(`"${deleteSubjectTarget.name}" deleted.`, "success");
      if (selectedId === deleteSubjectTarget.id) setSelectedId(null);
      setDeleteSubjectTarget(null);
      reloadSubjects();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setDeletingSubject(false);
    }
  }

  /**
   * The file panel for the selected subject.
   *
   * A function rather than inline JSX because both views need it: the
   * list view puts it in a sticky right-hand column, the map view puts it
   * under the graph. Two copies of this much markup would drift apart.
   */
  function renderFilePanel() {
    if (!selected) {
      return <p className="py-10 text-center text-sm text-base-400">Select a subject to see its files.</p>;
    }
    return (
      <div>
        <div className="mb-4 flex items-center gap-2">
          <FolderTree size={16} className="text-brand-400" />
          <h3 className="text-sm font-semibold text-base-50">{selected.name}</h3>
          <span className="text-xs text-base-500">{selected.materialized_path}</span>
          {canManage && selected.level !== "subcategory" && (
            <button
              className="btn-secondary btn-sm ml-auto"
              onClick={() => setFormTarget({ mode: "create", parentId: selected.id })}
            >
              <Plus size={13} /> Add {selected.level === "subject" ? "category" : "subcategory"}
            </button>
          )}
        </div>
        {/* Search inside this subject -- same engine as the Files
            page (content, AI title, summary, filename), scoped to
            this branch. */}
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-400" />
          <input
            className="input pl-9 text-sm"
            placeholder={`Search inside ${selected.name}…`}
            value={fileQuery}
            onChange={(e) => setFileQuery(e.target.value)}
          />
          {fileQuery && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-base-500 hover:text-base-200"
              onClick={() => setFileQuery("")}
              title="Clear"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {loadingDocs ? (
          <PageSpinner />
        ) : !documents?.length ? (
          <p className="text-sm text-base-400">
            {debouncedFileQuery
              ? `Nothing in ${selected.name} matches “${debouncedFileQuery}”.`
              : activeFilters > 0
                ? `No files under ${selected.name} match the current filters.`
                : "No files placed under this subject yet."}
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {documents.map((d) => (
                <li
                  key={d.id}
                  // Draggable straight onto a node in the map to reclassify.
                  // The custom MIME type keeps this from being interpreted
                  // as a text drop by anything else on the page.
                  draggable={hasPermission("classification.modify")}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/dms-file-id", d.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  className="table-row-hover flex cursor-pointer items-center gap-2.5 rounded-xl border border-white/5 bg-white/[0.02] px-3.5 py-2.5 text-sm active:cursor-grabbing"
                  onClick={() => setSelectedFileId(d.id)}
                >
                  <FileText size={14} className="mt-0.5 shrink-0 text-base-400" />
                  <div className="min-w-0 flex-1">
                    {/* display_name comes from listBySubject; search
                        results return the raw row, so fall back to
                        filename_current rather than rendering blank. */}
                    <p className="truncate font-medium text-base-100">
                      {d.ai_short_title || d.display_name || d.filename_current}
                    </p>
                    {d.ai_short_title ? (
                      <p className="flex items-center gap-1 truncate text-xs text-base-500">
                        <Sparkles size={10} className="shrink-0 text-brand-400" />
                        {d.display_name || d.filename_current}
                      </p>
                    ) : (
                      <p className="truncate font-mono text-xs text-base-500">{d.current_path}</p>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-base-500">
                      <DocumentDateInline date={d.document_date} source={d.document_date_source} />
                      <LocationLabel name={d.location_name} isReadOnly={d.location_is_read_only} />
                    </div>
                    <SearchSnippet snippet={d.snippet} />
                    <MatchReason file={d} />
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {hasPermission("document.download") && (
                      <button
                        className="btn-ghost btn-sm"
                        onClick={(e) => { e.stopPropagation(); setPreviewFileId(d.id); }}
                        title="Preview"
                      >
                        <Eye size={13} />
                      </button>
                    )}
                    <button
                      className="btn-ghost btn-sm"
                      onClick={(e) => { e.stopPropagation(); downloadFile(d.id, d.display_name || d.filename_current); }}
                      title="Download"
                    >
                      <Download size={13} />
                    </button>
                    {(hasPermission("document.rename") || hasPermission("classification.modify")) && (
                      <button
                        className="btn-ghost btn-sm"
                        onClick={(e) => { e.stopPropagation(); setEditFileTarget(d); }}
                        title="Edit"
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {hasPermission("classification.modify") && (
                      <button
                        className="btn-ghost btn-sm"
                        onClick={(e) => { e.stopPropagation(); setMoveFileTarget(d); }}
                        title="Move to another subject"
                      >
                        <FolderInput size={13} />
                      </button>
                    )}
                    {hasPermission("document.delete") && (
                      <button
                        className="btn-ghost btn-sm text-rose-400 hover:text-rose-300"
                        onClick={(e) => { e.stopPropagation(); setRemoveFileTarget(d); }}
                        title="Remove file"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <Pagination offset={fileOffset} limit={FILES_LIMIT} pageCount={documents?.length} onChange={setFileOffset} />
            </div>
          </>
        )}
      </div>
    );
  }

  if (loading) return <PageSpinner />;

  return (
    <div>
      <PageHeader
        title="Subjects"
        description="The taxonomy your repository is organized around — subject, category, subcategory."
        actions={
          canManage ? (
            <>
              <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
                <button
                  className={view === "list" ? "btn-secondary btn-sm" : "btn-ghost btn-sm"}
                  onClick={() => changeView("list")}
                  title="Compact list — fastest to scan and filter"
                >
                  <ListTree size={13} /> List
                </button>
                <button
                  className={view === "graph" ? "btn-secondary btn-sm" : "btn-ghost btn-sm"}
                  onClick={() => changeView("graph")}
                  title="Roadmap view — see the whole taxonomy at once"
                >
                  <Network size={13} /> Map
                </button>
              </div>
              <button className="btn-secondary btn-sm" onClick={() => setFormTarget({ mode: "create", parentId: null })}>
                <Plus size={13} /> Add subject
              </button>
            </>
          ) : null
        }
      />

      {/* Above the tree, because it changes the tree: the counts on every
          node are counts of the filtered set. showSubject is off -- the tree
          IS the subject picker. */}
      <FileFilters value={filters} onChange={setFilters} showSubject={false} />

      {activeFilters > 0 && (
        <p className="mb-3 text-xs text-amber-300/90">
          Filters are on — every count in the tree, and the files listed for a subject, describe only the
          matching files.
        </p>
      )}

      {subjectsError ? (
        <ErrorState error={subjectsError} onRetry={reloadSubjects} title="Couldn't load the taxonomy" />
      ) : !subjects?.length ? (
        <EmptyState
          icon={FolderTree}
          title="No taxonomy yet"
          description="Seed data defines the starting subjects; new ones can be added as the repository grows."
          action={
            canManage ? (
              <button className="btn-primary btn-sm" onClick={() => setFormTarget({ mode: "create", parentId: null })}>
                <Plus size={13} /> Add subject
              </button>
            ) : null
          }
        />
      ) : (
        view === "graph" ? (
          /* One tall canvas with the file panel OVERLAID on the right,
             rather than two stacked boxes. Stacking meant selecting a
             subject pushed the map around and you scrolled to see the
             result; overlaying keeps the map still and puts the files
             where your eye already is. */
          <div className="glass-card relative h-[calc(100vh-13rem)] overflow-hidden p-0">
            <SubjectGraph
              tree={tree}
              selectedId={selectedId}
              onSelect={(node) => setSelectedId(node.id)}
              highlight={treeFilter}
              matchedSubjectIds={matchedSubjectIds}
              onDropFile={reclassifyByDrop}
            />

            {/* Top-left: the zoom controls now own the bottom-left corner,
                and the top-left is the one area the tree itself never
                occupies (the root sits centred). */}
            <div className="pointer-events-none absolute left-3 top-3 w-[min(20rem,calc(100%-1.5rem))]">
              <div className="pointer-events-auto relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-400" />
                <input
                  className="input border-white/10 bg-base-950/85 pl-9 text-sm backdrop-blur"
                  placeholder="Search subjects and files…"
                  value={treeFilter}
                  onChange={(e) => setTreeFilter(e.target.value)}
                />
                {treeFilter && (
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-base-500 hover:text-base-200"
                    onClick={() => setTreeFilter("")}
                    title="Clear"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              {/* Matching files, listed under the box. Clicking one selects
                  its subject, which opens the branches above it and lights
                  the route -- so a search answers "where does this live?"
                  and not just "does it exist?". */}
              {fileMatches.length > 0 && (
                <div className="pointer-events-auto mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-base-950/95 py-1 backdrop-blur">
                  <p className="px-3 py-1 text-[10px] uppercase tracking-wider text-base-500">
                    {fileMatches.length} matching file{fileMatches.length === 1 ? "" : "s"}
                  </p>
                  {fileMatches.map((f) => (
                    <button
                      key={f.id}
                      className="block w-full px-3 py-1.5 text-left hover:bg-white/5 disabled:opacity-40"
                      disabled={!f.subject_id}
                      title={f.subject_id ? `Show in ${f.subject_name}` : "This file has not been classified into a subject yet"}
                      onClick={() => setSelectedId(f.subject_id)}
                    >
                      <span dir="auto" className="block truncate text-xs text-base-100">
                        {f.canonical_filename || f.filename_current}
                      </span>
                      <span className="block truncate text-[10px] text-base-500">
                        {f.subject_name || "unfiled"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selected && (
              <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-white/10 bg-base-950/95 shadow-2xl backdrop-blur">
                {/* Just a close affordance -- renderFilePanel already shows
                    the subject's name and path, and repeating them here
                    read as a bug. */}
                <div className="flex items-center justify-end border-b border-white/5 px-3 py-2">
                  <button className="btn-ghost btn-sm" onClick={() => setSelectedId(null)} title="Close panel">
                    <X size={14} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">{renderFilePanel()}</div>
              </div>
            )}
          </div>
        ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
          {/* Two things fix the "click a subject at the bottom, then scroll
              back up to see its files" problem:
              1. The tree scrolls inside its own pane instead of growing the
                 page, so the file panel (which renders at the TOP of the
                 next column) never ends up scrolled off screen above.
              2. `items-start` on the grid, so the detail panel below has
                 room to travel and `position: sticky` actually applies --
                 grid items stretch to equal height by default, which leaves
                 sticky nothing to stick within. */}
          <div className="glass-card flex max-h-[calc(100vh-15rem)] flex-col lg:col-span-2">
            <div className="shrink-0 border-b border-white/5 p-3">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-400" />
                <input
                  className="input pl-9 text-sm"
                  placeholder="Filter subjects…"
                  value={treeFilter}
                  onChange={(e) => setTreeFilter(e.target.value)}
                />
                {treeFilter && (
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-base-500 hover:text-base-200"
                    onClick={() => setTreeFilter("")}
                    title="Clear"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              {treeFilter && visibleTree.length === 0 && (
                <p className="mt-2 text-xs text-base-500">No subject matches “{treeFilter}”.</p>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <TreeLevel
              nodes={visibleTree}
              depth={0}
              // While filtering, every surviving branch is expanded -- hiding
              // a match behind a collapsed parent would defeat the filter.
              forceExpanded={Boolean(treeFilter)}
              highlight={treeFilter}
              selectedId={selectedId}
              onSelect={(node) => setSelectedId(node.id)}
              canManage={canManage}
              onAddChild={(parent) => setFormTarget({ mode: "create", parentId: parent.id })}
              onEdit={(subject) => setFormTarget({ mode: "edit", subject })}
              onDelete={(subject) => setDeleteSubjectTarget(subject)}
            />
            </div>
          </div>

          {/* Sticky on wide screens so the files stay in view no matter how
              far down the tree the selection is. On narrow screens the
              columns stack, so the panel is scrolled into view instead --
              see the effect on selectedId. */}
          <div
            ref={detailPanelRef}
            className="glass-card p-5 lg:sticky lg:top-4 lg:col-span-3 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto"
          >
            {renderFilePanel()}
          </div>
        </div>
        )
      )}

      <SubjectFormModal
        target={formTarget}
        subjects={subjects || []}
        onClose={() => setFormTarget(null)}
        onSaved={(savedId) => {
          setFormTarget(null);
          reloadSubjects();
          push(formTarget?.mode === "edit" ? "Subject updated." : "Subject created.", "success");
          if (formTarget?.mode === "create" && savedId) setSelectedId(savedId);
        }}
      />


      {/* The assistant itself now lives in the app shell (Layout) so it is
          available on every page. This page just publishes what is on
          screen -- see usePublishAssistantContext above. */}

      <ConfirmDialog
        open={Boolean(deleteSubjectTarget)}
        onClose={() => setDeleteSubjectTarget(null)}
        onConfirm={confirmDeleteSubject}
        loading={deletingSubject}
        danger
        title="Delete subject"
        confirmLabel="Delete"
        description={
          deleteSubjectTarget
            ? `Delete "${deleteSubjectTarget.name}"? This only works if it has no subcategories and no files currently classified under it — you'll get an error explaining what to move first if not.`
            : ""
        }
      />

      <FileDetailModal
        fileId={selectedFileId}
        onClose={() => setSelectedFileId(null)}
        onEdit={(f) => { setSelectedFileId(null); setEditFileTarget(f); }}
        onMove={(f) => { setSelectedFileId(null); setMoveFileTarget(f); }}
        onDelete={(f) => { setSelectedFileId(null); setRemoveFileTarget(f); }}
      />

      <PreviewModal fileId={previewFileId} onClose={() => setPreviewFileId(null)} />

      <EditFileModal
        file={editFileTarget}
        onClose={() => setEditFileTarget(null)}
        onSaved={() => { setEditFileTarget(null); reloadFiles(); push("File updated.", "success"); }}
      />

      <MoveFileModal
        file={moveFileTarget}
        onClose={() => setMoveFileTarget(null)}
        onMoved={() => { setMoveFileTarget(null); reloadFiles(); push("File moved.", "success"); }}
      />

      <ConfirmDialog
        open={Boolean(removeFileTarget)}
        onClose={() => setRemoveFileTarget(null)}
        onConfirm={confirmRemoveFile}
        loading={removingFile}
        danger
        title="Remove file"
        confirmLabel="Remove"
        description={
          removeFileTarget
            ? `Remove "${removeFileTarget.display_name || removeFileTarget.filename_current}"? It's marked deleted (not erased) and any pending rename proposal for it is cancelled.`
            : ""
        }
      />
    </div>
  );
}

/**
 * The count beside a subject in the tree.
 *
 * Shows the total INCLUDING descendants, because a parent like "Finance"
 * typically holds nothing directly while its children hold everything --
 * showing only the direct count would label most branches "0" and make a
 * populated taxonomy look empty. When the two differ, the tooltip breaks it
 * down so the number is never ambiguous.
 */
function SubjectCount({ node }) {
  const total = node.totalFileCount ?? 0;
  const direct = node.fileCount ?? 0;
  if (total === 0) return null;

  const title =
    total === direct
      ? `${direct} file${direct === 1 ? "" : "s"} in this subject`
      : `${total} file${total === 1 ? "" : "s"} in total — ${direct} directly here, ${total - direct} in subcategories`;

  return (
    <span
      className="ml-auto shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[11px] tabular-nums text-base-400"
      title={title}
    >
      {total}
    </span>
  );
}

/**
 * Keep a branch if it matches, OR if any descendant does.
 *
 * The second half is what makes this usable: typing "invoice" should still
 * show you Finance › Invoices, not hide the parent because the parent's own
 * name doesn't contain the word. A matching node also keeps all of its
 * children, so you can see what is inside the thing you just found.
 */
function filterTree(nodes, term) {
  const needle = term.trim().toLowerCase();
  if (!needle) return nodes;

  const walk = (list) =>
    list.reduce((kept, node) => {
      const selfMatches = node.name.toLowerCase().includes(needle);
      const children = selfMatches ? node.children : walk(node.children);
      if (selfMatches || children.length > 0) kept.push({ ...node, children });
      return kept;
    }, []);

  return walk(nodes);
}

/** Marks the matched substring inside a subject name. */
function HighlightedName({ name, term }) {
  const needle = (term || "").trim();
  if (!needle) return <span className="truncate">{name}</span>;

  const at = name.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return <span className="truncate">{name}</span>;

  return (
    <span className="truncate">
      {name.slice(0, at)}
      <mark className="rounded bg-brand-500/30 px-0.5 text-brand-100">{name.slice(at, at + needle.length)}</mark>
      {name.slice(at + needle.length)}
    </span>
  );
}

function buildTree(flat) {
  const byId = Object.fromEntries(flat.map((s) => [s.id, { ...s, children: [] }]));
  const roots = [];
  flat.forEach((s) => {
    if (s.parent_id && byId[s.parent_id]) byId[s.parent_id].children.push(byId[s.id]);
    else roots.push(byId[s.id]);
  });
  return roots;
}

function TreeLevel({
  nodes, depth, selectedId, onSelect, canManage, onAddChild, onEdit, onDelete,
  forceExpanded = false, highlight = "",
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => (
        <TreeNode
          key={node.id}
          node={node}
          depth={depth}
          selectedId={selectedId}
          onSelect={onSelect}
          canManage={canManage}
          onAddChild={onAddChild}
          onEdit={onEdit}
          onDelete={onDelete}
          forceExpanded={forceExpanded}
          highlight={highlight}
        />
      ))}
    </ul>
  );
}

/**
 * One row of the taxonomy tree, plus its children.
 *
 * The chevron used to be decorative: children were rendered unconditionally,
 * `forceExpanded` was threaded down through every level and never read, and
 * the arrow never moved. So the control said "this branch collapses" and
 * nothing collapsed -- on a taxonomy with a few hundred nodes that means
 * scrolling past every subcategory of every subject to reach the next one.
 *
 * Branches start open, which is what the tree did before, so nothing anyone
 * relied on changes. `forceExpanded` now does what its name always claimed:
 * while a filter is active, matches must stay visible regardless of what the
 * user had collapsed beforehand.
 */
function TreeNode({
  node, depth, selectedId, onSelect, canManage, onAddChild, onEdit, onDelete,
  forceExpanded, highlight,
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const expanded = forceExpanded || open;

  return (
    <li>
      <div
        className={`group flex w-full items-center gap-1 rounded-lg pr-1.5 text-left text-sm transition-colors
              ${selectedId === node.id ? "bg-brand-500/15 text-brand-200" : "text-base-300 hover:bg-white/[0.04]"}`}
      >
        {/* Its own control, not part of the select button -- expanding a
            branch and choosing a subject are different intentions, and
            merging them means you cannot look inside a subject without also
            navigating to it. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
            disabled={forceExpanded}
            className="shrink-0 rounded p-1 text-base-500 hover:text-base-200 disabled:opacity-40"
            style={{ marginLeft: 6 + depth * 16 }}
          >
            <ChevronRight
              size={12}
              className={"transition-transform " + (expanded ? "rotate-90" : "")}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="shrink-0" style={{ marginLeft: 6 + depth * 16, width: 22 }} />
        )}
        <button
          type="button"
          onClick={() => onSelect(node)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
        >
          <HighlightedName name={node.name} term={highlight} />
          <SubjectCount node={node} />
        </button>
        {canManage && (
          <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            {node.level !== "subcategory" && (
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => onAddChild(node)}
                title="Add subcategory"
                aria-label={`Add a subcategory under ${node.name}`}
              >
                <Plus size={12} />
              </button>
            )}
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => onEdit(node)}
              title="Rename"
              aria-label={`Rename ${node.name}`}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm text-rose-400 hover:text-rose-300"
              onClick={() => onDelete(node)}
              title="Delete"
              aria-label={`Delete ${node.name}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
      {hasChildren && expanded && (
        <TreeLevel
          nodes={node.children}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          canManage={canManage}
          onAddChild={onAddChild}
          onEdit={onEdit}
          onDelete={onDelete}
          forceExpanded={forceExpanded}
          highlight={highlight}
        />
      )}
    </li>
  );
}

/**
 * Handles both "add subject" (optionally under a parent) and "rename
 * subject" -- kept as one modal since the fields mostly overlap. Editing
 * deliberately can't change the parent/level (see subjectRepository.update)
 * so the tree's shape only ever grows top-down through "Add subcategory."
 */
function SubjectFormModal({ target, subjects, onClose, onSaved }) {
  const { push } = useToast();
  const open = Boolean(target);
  const mode = target?.mode;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === "edit") {
      setName(target.subject?.name || "");
      setDescription(target.subject?.description || "");
      setParentId(target.subject?.parent_id || "");
    } else {
      setName("");
      setDescription("");
      setParentId(target.parentId || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, target?.subject?.id, target?.parentId]);

  const parentOptions = useMemo(
    () => subjects.filter((s) => s.level !== "subcategory" && s.id !== target?.subject?.id),
    [subjects, target?.subject?.id]
  );

  // Context-specific title so it's unambiguous which level is being
  // created -- "Add subject" (top level) reads very differently from
  // "Add subcategory under Finance -> Budgets", and users flagged the
  // generic modal as making it unclear whether nesting was even possible.
  const parentForCreate = mode === "create" && target?.parentId
    ? subjects.find((s) => s.id === target.parentId)
    : null;
  const createLevelLabel = parentForCreate ? (parentForCreate.level === "subject" ? "category" : "subcategory") : "subject";
  const modalTitle = mode === "edit"
    ? "Rename subject"
    : parentForCreate
      ? `Add ${createLevelLabel} under ${parentForCreate.materialized_path || parentForCreate.name}`
      : "Add subject";

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { push("Name is required.", "error"); return; }

    setSaving(true);
    try {
      if (mode === "edit") {
        await api.patch(`/subjects/${target.subject.id}`, { name: trimmed, description: description.trim() || null });
        onSaved();
      } else {
        const created = await api.post("/subjects", {
          parentId: parentId || null,
          name: trimmed,
          description: description.trim() || null,
        });
        onSaved(created?.id);
      }
    } catch (err) {
      push(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={modalTitle}
      width="max-w-sm"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : mode === "edit" ? "Save changes" : "Create"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label mb-1.5 block">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>

        {mode === "edit" ? (
          <p className="text-xs text-base-500">
            Nested under: <span className="font-mono">{target?.subject?.materialized_path || "top level"}</span>
          </p>
        ) : (
          <div>
            <label className="label mb-1.5 block">Parent</label>
            <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">— Top level —</option>
              {parentOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.materialized_path || s.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-base-500">Up to three levels deep: Subject → Category → Subcategory.</p>
          </div>
        )}

        <div>
          <label className="label mb-1.5 block">Description</label>
          <textarea
            className="input"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>
    </Modal>
  );
}
