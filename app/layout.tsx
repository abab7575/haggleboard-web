import { Shell } from "../components/shell";
import { rootMetadata } from "../lib/indexing";
import { schibsted, splineMono, ultra } from "../lib/fonts";
import "./brand.css";

export const metadata = rootMetadata();
export const viewport = { themeColor: "#2A2BE0" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ultra.variable} ${schibsted.variable} ${splineMono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
