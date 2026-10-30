import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Separate from app.db: Mastra migrates this schema on version bumps, which must never
 * touch user data. Set MASTRA_DB_PATH: the module-relative default differs in Mastra's bundle.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url)); // …/src/mastra/server
const DEFAULT_DB_PATH = resolve(MODULE_DIR, "../../../.data/mastra.db");

function mastraDbUrl(): string {
  const path = process.env.MASTRA_DB_PATH ? resolve(process.env.MASTRA_DB_PATH) : DEFAULT_DB_PATH;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); // owner-only: tax data
  return `file:${path}`;
}

/* Traces live in memory and reset on restart. */
export async function createStorage(): Promise<MastraCompositeStore> {
  const libsql = new LibSQLStore({
    id: "openreturn-storage",
    url: mastraDbUrl(),
  });
  const inMemory = new InMemoryStore({ id: "openreturn-inmemory" });

  return new MastraCompositeStore({
    id: "openreturn-composite",
    default: libsql,
    domains: {
      observability: await inMemory.getStore("observability"),
    },
  });
}
