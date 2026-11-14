import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Indodax Dry Run Bot',
  description: 'Bot trading kripto dry run untuk UAS Algorithmic Trading'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
