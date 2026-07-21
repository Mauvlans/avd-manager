import type { AppProps } from "next/app";
import Link from "next/link";
import "../styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div>
      <header className="nav">
        <strong>AVD Manager</strong>
        <nav>
          <Link href="/onboarding">Onboarding</Link>
          <Link href="/host-pools">Host Pools</Link>
          <Link href="/cost">Cost</Link>
          <Link href="/audit-log">Audit Log</Link>
        </nav>
      </header>
      <main className="container">
        <Component {...pageProps} />
      </main>
    </div>
  );
}
