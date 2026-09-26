"use client";

// Generic open-data table: search across every field, click-to-sort columns, expand a row for its full JSON record,
// and download the current (filtered + sorted) rows as JSON or CSV.
import { Fragment, useId, useMemo, useState, type ReactNode } from "react";
import { matchesQuery, sortRows, toCsv, type SortValue } from "@/lib/openData";

export interface Column<T> {
  key: string;
  label: string;
  /** Used for sorting and search. */
  value: (row: T) => SortValue;
  /** Cell content; defaults to the value. */
  render?: (row: T) => ReactNode;
  /** Header tooltip. */
  title?: string;
  align?: "left" | "right";
  className?: string;
}

interface Props<T> {
  /** File-name stem for downloads, e.g. "sites" -> glassledger-sites-2026-09-26.csv */
  id: string;
  /** Human name of the table for labels ("sites", "on-chain transactions"). Default: id. */
  label?: string;
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** The full record: shown when a row is expanded and written to the downloads. Default: the row itself. */
  record?: (row: T) => unknown;
  /** Dotted keys left out of the CSV (e.g. a raw nested tx). The JSON download keeps them. */
  csvOmit?: string[];
  rowClassName?: (row: T) => string;
  initialSort?: { key: string; dir: "asc" | "desc" };
  pageSize?: number;
  empty?: ReactNode;
}

const identity = <T,>(r: T): unknown => r;

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900";

function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Clicks on links, buttons and text selections inside a row must not toggle it. */
function isInteractiveClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("a, button, input, select, textarea, summary")) return true;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return Boolean(sel && !sel.isCollapsed && sel.toString().length > 0);
}

export default function DataTable<T>({ id, label, rows, columns, rowKey, record = identity, csvOmit = [], rowClassName, initialSort, pageSize = 100, empty }: Props<T>) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [limit, setLimit] = useState(pageSize);
  const uid = useId();
  const name = label ?? id;

  // Search text per row: the full record plus what the columns show (so labels like "Blocked" match too).
  const indexed = useMemo(
    () =>
      rows.map((row) => ({
        row,
        text: `${JSON.stringify(record(row))} ${columns.map((c) => String(c.value(row) ?? "")).join(" ")}`.toLowerCase(),
      })),
    [rows, columns, record],
  );

  const visible = useMemo(() => {
    const q = query.trim();
    const hits = q ? indexed.filter((x) => matchesQuery(x.text, q)).map((x) => x.row) : rows;
    const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
    return col && sort ? sortRows(hits, col.value, sort.dir) : hits;
  }, [indexed, rows, query, sort, columns]);

  const toggleSort = (key: string) =>
    setSort((s) => (!s || s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));

  const toggleRow = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const download = (kind: "json" | "csv") => {
    const stamp = new Date().toISOString().slice(0, 10);
    const records = visible.map(record);
    if (kind === "json") saveFile(`glassledger-${id}-${stamp}.json`, `${JSON.stringify(records, null, 2)}\n`, "application/json");
    else saveFile(`glassledger-${id}-${stamp}.csv`, toCsv(records, csvOmit), "text/csv;charset=utf-8");
  };

  const shown = visible.slice(0, limit);
  const filtered = visible.length !== rows.length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search every field…"
          aria-label={`Search ${name}`}
          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-900 focus:outline-none sm:w-72"
        />
        <span className="text-xs text-gray-500 tabular-nums" aria-live="polite">
          {filtered ? `${visible.length} of ${rows.length} rows` : `${rows.length} rows`}
        </span>
        <span className="ml-auto flex gap-2">
          {(["json", "csv"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => download(kind)}
              disabled={visible.length === 0}
              title={`Download the ${visible.length} ${filtered ? "matching" : ""} ${name} rows as ${kind.toUpperCase()}`.replace(/\s+/g, " ")}
              className={`rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-800 hover:border-gray-900 disabled:opacity-40 ${FOCUS}`}
            >
              Download {kind.toUpperCase()}
            </button>
          ))}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-left text-sm">
          <caption className="sr-only">
            {name}: {visible.length} rows. Column headers sort; each row&apos;s first button shows its full record.
          </caption>
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th scope="col" className="w-8 px-2 py-2">
                <span className="sr-only">Details</span>
              </th>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={`whitespace-nowrap px-3 py-2 font-medium ${c.align === "right" ? "text-right" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      title={c.title ?? `Sort by ${c.label}`}
                      className={`inline-flex items-center gap-1 rounded-sm uppercase hover:text-gray-900 ${FOCUS}`}
                    >
                      {c.label}
                      <span aria-hidden className={active ? "text-gray-900" : "text-gray-300"}>
                        {active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-sm text-gray-500">
                  {rows.length === 0 ? (empty ?? "No records.") : "No rows match your search."}
                </td>
              </tr>
            )}
            {shown.map((row) => {
              const k = rowKey(row);
              const isOpen = open.has(k);
              const detailId = `${uid}-${k}`;
              return (
                <Fragment key={k}>
                  <tr
                    onClick={(e) => {
                      if (!isInteractiveClick(e.target)) toggleRow(k);
                    }}
                    className={`cursor-pointer align-top hover:bg-gray-50 ${isOpen ? "bg-gray-50" : ""} ${rowClassName?.(row) ?? ""}`}
                  >
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => toggleRow(k)}
                        aria-expanded={isOpen}
                        aria-controls={isOpen ? detailId : undefined}
                        aria-label={`${isOpen ? "Hide" : "Show"} the full record for ${k}`}
                        className={`flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-900 ${FOCUS}`}
                      >
                        <span aria-hidden className={`inline-block text-[10px] transition-transform ${isOpen ? "rotate-90" : ""}`}>
                          ▶
                        </span>
                      </button>
                    </td>
                    {columns.map((c) => (
                      <td key={c.key} className={`px-3 py-2 ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                        {c.render ? c.render(row) : (c.value(row) ?? "")}
                      </td>
                    ))}
                  </tr>
                  {isOpen && (
                    <tr className="bg-gray-50">
                      <td colSpan={columns.length + 1} className="px-3 pb-3">
                        {/* Sticky + capped width: the record stays readable at the left edge however wide the table scrolls. */}
                        <div id={detailId} className="sticky left-3 max-w-[min(calc(100vw-5rem),75rem)]">
                          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded-md border border-gray-200 bg-white p-3 font-mono text-xs text-gray-800">
                            {JSON.stringify(record(row), null, 2)}
                          </pre>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {visible.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + pageSize)}
          className={`rounded-sm text-sm font-medium text-gray-700 underline hover:text-gray-900 ${FOCUS}`}
        >
          Show {Math.min(pageSize, visible.length - limit)} more ({visible.length - limit} hidden)
        </button>
      )}
    </div>
  );
}
