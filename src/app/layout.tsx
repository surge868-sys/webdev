import type { Metadata, Viewport } from 'next';
import './globals.css';


export const metadata: Metadata = {
  title: 'BRIDGE STRIKE!',
  description: 'Haul three excavators, a grain bin and some farm equipment into Saskatoon without meeting an overpass. One thumb. No permit. Based on a true year.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://bridgestrike.vercel.app'),
  openGraph: {
    title: 'BRIDGE STRIKE!',
    description: 'Haul the load. Read the plates. Duck. Based on a true year in Saskatoon.',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'BRIDGE STRIKE! — a Peterbilt hauling an excavator toward an overpass' }],
  },
  twitter: { card: 'summary_large_image', title: 'BRIDGE STRIKE!', description: 'Haul the load. Read the plates. Duck.', images: ['/og.png'] },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'BRIDGE STRIKE!' },
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
    <html lang="en" className="h-full antialiased">
      <body className="h-full overflow-hidden bg-[#0b1020]">{children}</body>
    </html>
  );
}
