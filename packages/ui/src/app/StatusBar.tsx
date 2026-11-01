export function StatusBar({ items }: { items: (string | false | undefined)[] }) {
  return (
    <footer className="status-bar">
      {items.filter(Boolean).map((item, i) => (
        <span key={i}>{item}</span>
      ))}
    </footer>
  );
}
