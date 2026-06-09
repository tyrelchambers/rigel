import { NavLink, Routes, Route } from "react-router";

const PANELS = ["overview", "pods", "deployments", "services"]; // grows as panels are ported

export default function App() {
  return (
    <div className="flex h-screen">
      <nav className="w-48 border-r p-2 space-y-1">
        {PANELS.map((p) => (
          <NavLink key={p} to={`/${p}`} className="block rounded px-2 py-1 hover:bg-muted capitalize">
            {p}
          </NavLink>
        ))}
      </nav>
      <main className="flex-1 overflow-auto p-4">
        <Routes>
          <Route path="/" element={<div>Helmsman Web</div>} />
          {PANELS.map((p) => (
            <Route key={p} path={`/${p}`} element={<div className="capitalize">{p} panel (not yet ported)</div>} />
          ))}
        </Routes>
      </main>
    </div>
  );
}
