import { useEffect, useRef, useState } from "react";
import { useProject, useSession, useSessionUi } from "../state/hooks";

/** The project name button and its menu: new, rename, import/export, recent projects. */
export function ProjectMenu() {
  const session = useSession();
  const name = useProject((s) => s.project.name);
  const currentId = useProject((s) => s.project.id);
  const projects = useSessionUi((s) => s.projects);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const act = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="project-menu" ref={root}>
      <button
        className="project-button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="project-name" data-testid="project-name">
          {name}
        </span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <label className="menu-field">
            <span>Name</span>
            <input
              defaultValue={name}
              aria-label="Project name"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  session.rename(e.currentTarget.value);
                  setOpen(false);
                }
              }}
              onBlur={(e) => session.rename(e.target.value)}
            />
          </label>
          <button role="menuitem" onClick={act(() => void session.newProject())}>
            New project
          </button>
          <label role="menuitem" className="menu-file">
            Import .tessera…
            <input
              type="file"
              accept=".tessera,application/zip"
              data-testid="import-archive"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                setOpen(false);
                if (file) void session.importArchive(file);
              }}
            />
          </label>
          <button role="menuitem" onClick={act(() => void session.exportArchive())}>
            Export .tessera…
          </button>
          {projects.length > 0 && <div className="menu-heading">Recent projects</div>}
          {projects.map((p) => (
            <div className="menu-project" key={p.id}>
              <button
                role="menuitem"
                className={p.id === currentId ? "current" : undefined}
                onClick={act(() => p.id !== currentId && void session.openProject(p.id))}
                title={p.modifiedAt ? `Saved ${new Date(p.modifiedAt).toLocaleString()}` : undefined}
              >
                {p.name}
              </button>
              <button
                className="delete"
                aria-label={`Delete ${p.name}`}
                title="Delete project"
                onClick={act(() => {
                  if (confirm(`Delete "${p.name}" and its audio? This can't be undone.`))
                    void session.deleteProject(p.id);
                })}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
