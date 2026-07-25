import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = "Obsidian Atlas — visor del Overworld de 2b2t";
const description =
  "Descarga regiones completas del Overworld de 2b2t, explóralas celda por celda y guarda el progreso automáticamente.";
const localOrigin = new URL("http://localhost:3001");

export const metadata: Metadata = {
  metadataBase: localOrigin,
  title,
  description,
  applicationName: "Obsidian Atlas",
  keywords: ["2b2t", "Minecraft", "Overworld", "mapa", "coordenadas"],
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    type: "website",
    locale: "es_GT",
    title,
    description,
    siteName: "Obsidian Atlas",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Obsidian Atlas sobre un mapa del Overworld",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
