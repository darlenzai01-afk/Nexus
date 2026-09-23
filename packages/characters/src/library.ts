import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "@nexus/storage";

import { verifyCharacterAssets, type CharacterAssetCheck } from "./assets.js";
import {
  characterHash,
  resolveCharacter,
  type CharacterSelection,
  type ResolvedCharacter,
} from "./resolve.js";
import {
  parseCharacter,
  parseCharacterLibraryIndex,
  type Character,
  type CharacterLibraryIndex,
  type CharacterRole,
} from "./schema.js";

/**
 * The character library: the set of definitions a project draws characters from.
 *
 * A library is a directory — `characters/index.json` naming the definition files,
 * `characters/<id>.json` for each character, and `assets/**` for the art those
 * definitions reference. `@nexus/characters` ships one small, original
 * demonstration set; a project points `load({ dir })` at its own directory and
 * everything downstream (cast lists, scene references, resolution) works the same.
 *
 * Loading is strict and fails fast: the index and every definition are parsed
 * against their schemas, ids are unique, the default cast exists, and — when
 * asked — every referenced asset is on disk with the size and hash the definition
 * recorded.
 */

export interface CharacterDefinition {
  readonly character: Character;
  /** sha256 of the definition's canonical bytes. */
  readonly hash: string;
}

/** What a manifest records about the character it referenced (no definition copied). */
export interface CharacterReference {
  readonly characterId: string;
  readonly version: number;
  readonly hash: string;
}

/** A cast member pointing at a definition, in the shape a scene manifest wants. */
export interface LibraryCastMember {
  readonly id: string;
  readonly name: string;
  readonly role: CharacterRole;
  readonly description: string;
  readonly definition: CharacterReference;
}

export interface LoadCharacterLibraryOptions {
  /** Library root; defaults to the bundled demonstration set. */
  readonly dir?: string;
  /** Verify every referenced asset (bytes + sha256) while loading. */
  readonly verifyAssets?: boolean;
}

export class CharacterLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterLibraryError";
  }
}

export class UnknownCharacterError extends Error {
  readonly characterId: string;
  readonly available: readonly string[];

  constructor(characterId: string, available: readonly string[]) {
    super(`unknown character "${characterId}" (library has: ${available.join(", ") || "none"})`);
    this.name = "UnknownCharacterError";
    this.characterId = characterId;
    this.available = available;
  }
}

const LIBRARY_SUBDIR = "characters";
const INDEX_FILE = "index.json";

/** The @nexus/characters package directory, from either `src/` or `dist/`. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === "@nexus/characters") return dir;
      } catch {
        // A package.json we cannot read is not ours; keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CharacterLibraryError(
    "cannot locate the @nexus/characters package root (pass { dir } to load a library from elsewhere)",
  );
}

/** The bundled demonstration set's root directory. */
export function demoRoot(): string {
  return packageRoot();
}

export class CharacterLibrary {
  readonly #index: CharacterLibraryIndex;
  readonly #definitions: ReadonlyMap<string, CharacterDefinition>;
  readonly #root: string | undefined;

  private constructor(
    index: CharacterLibraryIndex,
    definitions: ReadonlyMap<string, CharacterDefinition>,
    root: string | undefined,
  ) {
    this.#index = index;
    this.#definitions = definitions;
    this.#root = root;
  }

  /**
   * Build a library from documents already in memory (tests, a database, an
   * imported set). Pass an index to control the default cast; without one the
   * first character becomes the default cast.
   */
  static from(
    documents: readonly unknown[],
    options: { readonly index?: unknown; readonly root?: string } = {},
  ): CharacterLibrary {
    if (documents.length === 0)
      throw new CharacterLibraryError("a character library needs at least one character");
    const definitions = new Map<string, CharacterDefinition>();
    for (const [position, document] of documents.entries()) {
      let character: Character;
      try {
        character = parseCharacter(document);
      } catch (error) {
        throw new CharacterLibraryError(
          `invalid character document at position ${position}: ${message(error)}`,
        );
      }
      if (definitions.has(character.id)) {
        throw new CharacterLibraryError(
          `character id ${character.id} appears twice (documents ${position} and earlier)`,
        );
      }
      definitions.set(character.id, { character, hash: characterHash(character) });
    }

    const ids = [...definitions.keys()];
    const index =
      options.index === undefined
        ? parseCharacterLibraryIndex({
            version: 1,
            name: "ad-hoc",
            defaultCast: [{ characterId: ids[0]!, role: definitions.get(ids[0]!)!.character.role }],
            characters: ids.map((id) => `${LIBRARY_SUBDIR}/${id}.json`),
          })
        : parseCharacterLibraryIndex(options.index);

    for (const entry of index.defaultCast) {
      if (!definitions.has(entry.characterId)) {
        throw new CharacterLibraryError(
          `default cast names ${entry.characterId}, which is not in this library`,
        );
      }
    }
    return new CharacterLibrary(index, definitions, options.root);
  }

  /** Read a library from disk. Defaults to the bundled demonstration set. */
  static load(options: LoadCharacterLibraryOptions = {}): CharacterLibrary {
    const root = path.resolve(options.dir ?? demoRoot());
    const indexFile = path.join(root, LIBRARY_SUBDIR, INDEX_FILE);
    if (!fs.existsSync(indexFile)) {
      throw new CharacterLibraryError(
        `no character library at ${root}: ${indexFile} does not exist`,
      );
    }
    let index: CharacterLibraryIndex;
    try {
      index = parseCharacterLibraryIndex(JSON.parse(fs.readFileSync(indexFile, "utf8")));
    } catch (error) {
      throw new CharacterLibraryError(
        `invalid character library index ${indexFile}: ${message(error)}`,
      );
    }

    const definitions = new Map<string, CharacterDefinition>();
    for (const relative of index.characters) {
      const file = path.join(root, ...relative.split("/"));
      if (!fs.existsSync(file)) {
        throw new CharacterLibraryError(
          `character library index names ${relative}, which does not exist`,
        );
      }
      let character: Character;
      try {
        character = parseCharacter(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch (error) {
        throw new CharacterLibraryError(`invalid character definition ${file}: ${message(error)}`);
      }
      if (definitions.has(character.id)) {
        throw new CharacterLibraryError(`character id ${character.id} appears twice (${relative})`);
      }
      definitions.set(character.id, { character, hash: characterHash(character) });
    }
    for (const entry of index.defaultCast) {
      if (!definitions.has(entry.characterId)) {
        throw new CharacterLibraryError(
          `default cast names ${entry.characterId}, which no definition file declares`,
        );
      }
    }

    const library = new CharacterLibrary(index, definitions, root);
    if (options.verifyAssets === true) {
      for (const { characterId, checks } of library.verifyAssets()) {
        const broken = checks.find((check) => !check.ok);
        if (broken !== undefined) {
          throw new CharacterLibraryError(
            `${characterId} asset ${broken.assetId} (${broken.path}) is ${broken.problem}: ` +
              `the definition says ${broken.expected.bytes} bytes / ${broken.expected.hash.slice(0, 12)}`,
          );
        }
      }
    }
    return library;
  }

  /** The index document (name, default cast, file list). */
  get index(): CharacterLibraryIndex {
    return this.#index;
  }

  get name(): string {
    return this.#index.name;
  }

  /** The library root, when it was loaded from (or given) a directory. */
  get root(): string | undefined {
    return this.#root;
  }

  get size(): number {
    return this.#definitions.size;
  }

  ids(): string[] {
    return [...this.#definitions.keys()];
  }

  list(): CharacterDefinition[] {
    return [...this.#definitions.values()];
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  get(id: string): Character | undefined {
    return this.#definitions.get(id)?.character;
  }

  require(id: string): Character {
    const found = this.#definitions.get(id);
    if (found === undefined) throw new UnknownCharacterError(id, this.ids());
    return found.character;
  }

  hashOf(id: string): string {
    const found = this.#definitions.get(id);
    if (found === undefined) throw new UnknownCharacterError(id, this.ids());
    return found.hash;
  }

  /** What a scene manifest records instead of copying a definition. */
  ref(id: string): CharacterReference {
    const character = this.require(id);
    return { characterId: character.id, version: character.version, hash: this.hashOf(id) };
  }

  /** A cast member for this character, in the role the caller wants it cast. */
  castMember(id: string, role: CharacterRole = this.require(id).role): LibraryCastMember {
    const character = this.require(id);
    return {
      id: character.id,
      name: character.identity.name,
      role,
      description: character.identity.description,
      definition: this.ref(character.id),
    };
  }

  /** The cast a project gets when it does not ask for one. */
  defaultCast(): LibraryCastMember[] {
    return this.#index.defaultCast.map((entry) => this.castMember(entry.characterId, entry.role));
  }

  resolve(id: string, selection: CharacterSelection = {}): ResolvedCharacter {
    return resolveCharacter(this.require(id), selection);
  }

  /** Verify every asset of every character (needs a root). */
  verifyAssets(): { characterId: string; checks: CharacterAssetCheck[] }[] {
    const root = this.#root;
    if (root === undefined) {
      throw new CharacterLibraryError(
        "this library was built from documents in memory: pass { root } to check its assets on disk",
      );
    }
    return this.list().map(({ character }) => ({
      characterId: character.id,
      checks: verifyCharacterAssets(character, root),
    }));
  }

  /**
   * A hash of the whole set: sorted `id:definition-hash` lines. Two libraries with
   * the same characters have the same hash, whatever order the files were read in.
   */
  get hash(): string {
    const lines = [...this.#definitions.entries()]
      .map(([id, definition]) => `${id}:${definition.hash}`)
      .sort();
    return sha256(new TextEncoder().encode(`${lines.join("\n")}\n`));
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
