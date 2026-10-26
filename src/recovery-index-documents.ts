/** Read-only qmd2.5.3 payload verification, including retained inactive content. */
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { getExportableCollections } from "@qmd-team-intent-kb/qmd-adapter";

const UUID_MD =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;
function requireTenant(text: string, tenantId: string): void {
  const end = text.indexOf("\n---\n", 4);
  const tenants = [
    ...text.slice(0, end).matchAll(/^tenant_id: "([^"\n]*)"$/gm),
  ];
  if (
    !text.startsWith("---\n") ||
    end < 0 ||
    tenants.length !== 1 ||
    tenants[0][1] !== tenantId
  )
    throw new Error("Recovery qmd retains a foreign or unattributed payload");
}

/** Pinned qmd2.5.3 Markdown extractor (including its Notes special case). */
function documentTitle(text: string, path: string): string {
  const match = text.match(/^##?\s+(.+)$/m);
  if (match) {
    const title = (match[1] ?? "").trim();
    if (title === "📝 Notes" || title === "Notes") {
      const next = text.match(/^##\s+(.+)$/m);
      if (next?.[1]) return next[1].trim();
    }
    if (title) return title;
  }
  return (
    path
      .replace(/\.[^.]+$/, "")
      .split("/")
      .pop() || path
  );
}

/** Before update, stale own-tenant documents are permitted; foreign history is not. */
export function verifyRecoveryIndexDocuments(
  indexPath: string,
  tenantId: string,
  expected?: ReadonlyMap<string, string>,
): number {
  const collections = new Map(
    getExportableCollections().map((d) => [d.name, d.sourceSubdir]),
  );
  const db = new Database(indexPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .transaction(() => {
        const content = new Map<string, string>();
        for (const row of db
          .prepare("SELECT hash,doc FROM content")
          .iterate() as Iterable<{ hash: string; doc: string }>) {
          if (
            typeof row.doc !== "string" ||
            typeof row.hash !== "string" ||
            createHash("sha256").update(row.doc).digest("hex") !== row.hash
          )
            throw new Error("Recovery qmd content hash differs");
          requireTenant(row.doc, tenantId);
          content.set(row.hash, row.doc);
        }
        const active = new Map<
          string,
          { id: number; text: string; title: string }
        >();
        const byId = new Map<number, string>();
        for (const row of db
          .prepare("SELECT id,collection,path,title,hash,active FROM documents")
          .iterate() as Iterable<{
          id: number;
          collection: string;
          path: string;
          title: string;
          hash: string;
          active: number;
        }>) {
          const directory = collections.get(row.collection);
          const text = content.get(row.hash);
          if (
            directory === undefined ||
            !UUID_MD.test(row.path) ||
            text === undefined ||
            ![0, 1].includes(row.active)
          )
            throw new Error("Recovery qmd document identity differs");
          if (row.title !== documentTitle(text, row.path))
            throw new Error("Recovery qmd document title differs from content");
          if (row.active === 1) {
            const path = `${directory}/${row.path}`;
            if (active.has(path))
              throw new Error("Duplicate recovery qmd document");
            active.set(path, { id: row.id, text, title: row.title });
            byId.set(row.id, `${row.collection}/${row.path}`);
          }
        }
        if (
          expected !== undefined &&
          (active.size !== expected.size ||
            [...expected].some(
              ([path, text]) => active.get(path)?.text !== text,
            ))
        )
          throw new Error(
            "Recovery qmd active documents differ from canonical export",
          );
        // qmd's pinned v2.5.3 FTS projection spaces CJK runs; check the exact projection.
        const normalize = (text: string) =>
          text.replace(
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
            (run) => ` ${Array.from(run).join(" ")} `,
          );
        const fts = db
          .prepare("SELECT rowid,filepath,title,body FROM documents_fts")
          .all() as Array<{
          rowid: number;
          filepath: string;
          title: string;
          body: string;
        }>;
        if (fts.length !== active.size)
          throw new Error("Recovery qmd FTS document set differs");
        const values = new Map(
          [...active.values()].map((row) => [row.id, row]),
        );
        for (const row of fts) {
          const original = values.get(row.rowid);
          if (
            original === undefined ||
            row.filepath !== normalize(byId.get(row.rowid)!) ||
            row.title !== normalize(original.title) ||
            row.body !== normalize(original.text)
          )
            throw new Error("Recovery qmd FTS projection differs");
        }
        return active.size;
      })
      .deferred();
  } finally {
    db.close();
  }
}
