import { Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { AccessPage } from './pages/AccessPage';
import { AuthPage } from './pages/AuthPage';
import { LandingPage } from './pages/LandingPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { PasswordPage } from './pages/PasswordPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { SignOutPage } from './pages/SignOutPage';

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/inscription" element={<AuthPage mode="signup" />} />
            <Route path="/connexion" element={<AuthPage mode="login" />} />
            <Route
              path="/bienvenue"
              element={
                <RequireAuth>
                  <OnboardingPage />
                </RequireAuth>
              }
            />
            <Route
              path="/acces"
              element={
                <RequireAuth>
                  <AccessPage />
                </RequireAuth>
              }
            />
            <Route path="/mot-de-passe" element={<PasswordPage />} />
            <Route path="/deconnexion" element={<SignOutPage />} />
            <Route path="/confidentialite" element={<PrivacyPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Layout>
      </AuthProvider>
    </ErrorBoundary>
  );
}
