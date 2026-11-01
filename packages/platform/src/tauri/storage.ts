import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { Project } from "@tessera/schema";
import type { ProjectStorage, ProjectSummary } from "../index";

/** Desktop project storage, implemented by the Rust commands in apps/desktop/src-tauri/src/storage.rs. */
export class TauriStorage implements ProjectStorage {
  list(): Promise<ProjectSummary[]> {
    return invoke("project_list");
  }

  open(id: string): Promise<Project> {
    return invoke("project_open", { id });
  }

  save(project: Project): Promise<void> {
    return invoke("project_save", { project });
  }

  async writeFile(projectId: string, path: string, data: Blob): Promise<void> {
    await invoke("project_write_file", new Uint8Array(await data.arrayBuffer()), {
      headers: { "x-project-id": encodeURIComponent(projectId), "x-path": encodeURIComponent(path) },
    });
  }

  async readFile(projectId: string, path: string): Promise<File> {
    const bytes = await invoke<ArrayBuffer>("project_read_file", { id: projectId, path });
    return new File([bytes], path.split("/").at(-1) ?? path);
  }

  delete(projectId: string): Promise<void> {
    return invoke("project_delete", { id: projectId });
  }

  async exportArchive(projectId: string): Promise<boolean> {
    const project = await this.open(projectId);
    const dest = await save({
      defaultPath: `${project.name.replace(/[\\/:*?"<>|]+/g, "_") || "project"}.tessera`,
      filters: [{ name: "Tessera project", extensions: ["tessera"] }],
    });
    if (!dest) return false;
    await invoke("project_export", { id: projectId, dest });
    return true;
  }

  async importArchive(file: File, newId: string): Promise<Project> {
    return invoke("project_import", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-project-id": encodeURIComponent(newId) },
    });
  }
}
