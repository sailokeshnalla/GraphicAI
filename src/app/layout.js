import './globals.css';
import { AuthProvider } from '@/context/AuthContext';
import Navbar from '@/components/layout/Navbar';
import ApiKeyGate from '@/components/auth/ApiKeyGate';

export const metadata = {
  title: 'GraphicAI',
  description: 'Turn ideas into presentation-ready decks',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <AuthProvider>
          <Navbar />
          <ApiKeyGate />   {/* ← shows popup whenever logged-in user has no key */}
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}