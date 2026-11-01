import type { Project } from "@tessera/schema";
import type { ProjectStorage, ProjectSummary } from "../index";
import type { WorkerClient } from "./workerClient";

const PROJECT_FILE = "project.json";

/**
 * Projects in the Origin Private File System: `projects/<id>/project.json` and
 * `projects/<id>/audio/...`. Chromium supports writing from the main thread.
 */
export class OpfsStorage implements ProjectStorage {
  constructor(private readonly worker: WorkerClient) {}

  async list(): Promise<ProjectSummary[]> {
    const out: ProjectSummary[] = [];
    for await (const [id, handle] of entries(await this.root())) {
      if (handle.kind !== "directory") continue;
      try {
        const file = await (
          await (handle as FileSystemDirectoryHandle).getFileHandle(PROJECT_FILE)
        ).getFile();
        const json = JSON.parse(await file.text()) as Partial<Project>;
        out.push({ id, name: json.name ?? id, modifiedAt: json.modifiedAt ?? "" });
      } catch {
        // Not a project (or a half-written one); skip it.
      }
    }
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async open(id: string): Promise<Project> {
    const file = await (await (await this.projectDir(id, false)).getFileHandle(PROJECT_FILE)).getFile();
    const json = await this.worker.call({ kind: "loadProject", json: await file.text() });
    return JSON.parse(json) as Project;
  }

  async save(project: Project): Promise<void> {
    const dir = await this.projectDir(project.id, true);
    await writeFile(
      dir,
      PROJECT_FILE,
      new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }),
    );
  }

  async writeFile(projectId: string, path: string, data: Blob): Promise<void> {
    const { dir, name } = await resolve(await this.projectDir(projectId, true), path, true);
    await writeFile(dir, name, data);
  }

  async readFile(projectId: string, path: string): Promise<File> {
    const { dir, name } = await resolve(await this.projectDir(projectId, false), path, false);
    return (await dir.getFileHandle(name)).getFile();
  }

  async delete(projectId: string): Promise<void> {
    await (await this.root()).removeEntry(projectId, { recursive: true });
  }

  async exportArchive(projectId: string): Promise<boolean> {
    const dir = await this.projectDir(projectId, false);
    const files: [string, Uint8Array][] = [];
    for await (const [path, file] of walk(dir, ""))
      files.push([path, new Uint8Array(await file.arrayBuffer())]);
    const project = JSON.parse(
      new TextDecoder().decode(files.find(([p]) => p === PROJECT_FILE)?.[1] ?? new Uint8Array()),
    ) as Partial<Project>;
    const zip = await this.worker.call(
      { kind: "pack", entries: files },
      files.map(([, d]) => d.buffer),
    );
    download(
      new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
      `${safeName(project.name ?? "project")}.tessera`,
    );
    return true;
  }

  async importArchive(file: File, newId: string): Promise<Project> {
    const bytes = await file.arrayBuffer();
    const entries = await this.worker.call({ kind: "unpack", bytes }, [bytes]);
    const projectEntry = entries.find(([path]) => path === PROJECT_FILE);
    if (!projectEntry) throw new Error("This .tessera file has no project.json.");
    const json = await this.worker.call({
      kind: "loadProject",
      json: new TextDecoder().decode(projectEntry[1]),
    });
    const project = { ...(JSON.parse(json) as Project), id: newId };
    for (const [path, data] of entries) {
      if (path !== PROJECT_FILE)
        await this.writeFile(newId, path, new Blob([data as Uint8Array<ArrayBuffer>]));
    }
    await this.save(project);
    return project;
  }

  private async root(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("projects", { create: true });
  }

  private async projectDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error(`invalid project id: ${id}`);
    return (await this.root()).getDirectoryHandle(id, { create });
  }
}

async function resolve(root: FileSystemDirectoryHandle, path: string, create: boolean) {
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`invalid path: ${path}`);
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
  return { dir, name: parts.at(-1)! };
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob) {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

/** `entries()` is missing from some lib.dom versions. */
function entries(dir: FileSystemDirectoryHandle): AsyncIterable<[string, FileSystemHandle]> {
  return (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
}

async function* walk(dir: FileSystemDirectoryHandle, prefix: string): AsyncGenerator<[string, File]> {
  for await (const [name, handle] of entries(dir)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") yield* walk(handle as FileSystemDirectoryHandle, path);
    else yield [path, await (handle as FileSystemFileHandle).getFile()];
  }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "project";
}
