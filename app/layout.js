import "./globals.css";

export const metadata = { title: "Slip Lab", description: "Accumulator slips by target odds" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
