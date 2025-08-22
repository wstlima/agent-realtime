export const metadata = { title: 'ASR Conversational' }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-br"><body style={{ fontFamily:'system-ui' }}>{children}</body></html>
  )
}
