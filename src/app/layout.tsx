import type { Metadata, Viewport } from 'next';
import { Oswald, Anton } from 'next/font/google';
import './globals.css';

const oswald = Oswald({ variable: '--font-hud', subsets: ['latin'], weight: ['400', '700'] });
const anton = Anton({ variable: '--font-big', subsets: ['latin'], weight: ['400'] });

export const metadata: Metadata = {
  title: 'BRIDGE STRIKE! — haul the load, miss the overpass',
  description: 'A one-thumb browser game about hauling an oversized load into a prairie city without smashing it into an overpass.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0b6b3a',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${oswald.variable} ${anton.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden bg-[#0b1020]">{children}</body>
    </html>
  );
}
