import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppShell } from './components/AppShell';
import { I18nProvider } from './lib/i18n';
import { AgentsPage } from './pages/AgentsPage';
import { DashboardPage } from './pages/DashboardPage';
import { FilesPage } from './pages/FilesPage';
import { GlobalChatPage } from './pages/GlobalChatPage';
import { ProjectPage } from './pages/ProjectPage';
import { RoomPage } from './pages/RoomPage';
import { SkillsPage } from './pages/SkillsPage';
import { WorkflowOverflowPage } from './pages/WorkflowOverflowPage';
import { getThemeTone, parseThemeMode, type ThemeMode } from './lib/theme';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

function getInitialTheme(): ThemeMode {
  const storedTheme = localStorage.getItem('openclaw-room-theme');
  return parseThemeMode(storedTheme);
}

function RootApp(): JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const tone = getThemeTone(theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', tone === 'dark');
    document.documentElement.style.colorScheme = tone;
    localStorage.setItem('openclaw-room-theme', theme);
  }, [theme, tone]);

  const toasterTheme = tone;

  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppShell theme={theme} onThemeChange={setTheme}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/chat" element={<GlobalChatPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/files" element={<FilesPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/workflow" element={<WorkflowOverflowPage />} />
              <Route path="/projects/:projectId" element={<ProjectPage />} />
              <Route path="/projects/:projectId/files" element={<FilesPage />} />
              <Route path="/projects/:projectId/rooms/:roomId" element={<RoomPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppShell>
          <Toaster theme={toasterTheme} position="bottom-right" richColors />
        </BrowserRouter>
      </QueryClientProvider>
    </I18nProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);
