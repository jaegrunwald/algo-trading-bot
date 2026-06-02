import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Trading Hub",
  description: "Algo trading dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full flex flex-col bg-bg text-text">
        <Providers>
          <Header />
          <div className="flex flex-1 overflow-hidden min-h-0">
            <Sidebar />
            <main className="flex-1 overflow-y-auto p-5 flex flex-col">
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
