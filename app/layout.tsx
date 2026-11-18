import type { Metadata } from 'next';
import { Fira_Code, Fira_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// next/font downloads and self-hosts these at build time; nothing loads from Google at runtime.
const sans = Fira_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});
const mono = Fira_Code({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Codebase City',
  description: 'A 3D city and treemap of a public GitHub repo, coloured by git-history signals.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a href="#main" className="skip">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
