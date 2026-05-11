import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Sidebar from "@/components/Sidebar";
import RefreshButton from "@/components/RefreshButton";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Nate Trader Dashboard",
  description: "Autonomous trading agent dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-screen flex bg-background text-foreground">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <div className="max-w-[1600px] mx-auto p-8">
            <div className="flex justify-end mb-4">
              <RefreshButton />
            </div>
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}
