import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { AppShell } from './components/AppShell';
import { api } from './lib/api';
import { I18nProvider } from './lib/i18n';
import { AgentsPage } from './pages/AgentsPage';
import { DashboardPage } from './pages/DashboardPage';
import { FilesPage } from './pages/FilesPage';
import { GlobalChatPage } from './pages/GlobalChatPage';
import { ProjectPage } from './pages/ProjectPage';
import { RoomPage } from './pages/RoomPage';
import { SkillsPage } from './pages/SkillsPage';
import { getThemeTone, parseThemeMode, type ThemeMode } from './lib/theme';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});
const PROVIDER_SUPERPOWERS_NOTICE_KEY = 'opendeepsea.providerSuperpowersNotice.v1';

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
            <ProviderSuperpowersStartupNotice />
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/chat" element={<GlobalChatPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/files" element={<FilesPage />} />
              <Route path="/skills" element={<SkillsPage />} />
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

function ProviderSuperpowersStartupNotice(): null {
  const { data } = useQuery({
    queryKey: ['provider-superpowers', 'status'],
    queryFn: api.getProviderSuperpowersStatus,
    refetchInterval: (query) => query.state.data?.running ? 2000 : false,
    staleTime: 2000,
  });

  useEffect(() => {
    if (!data || data.running || !data.completed_at) return;
    if (localStorage.getItem(PROVIDER_SUPERPOWERS_NOTICE_KEY)) return;

    const installedByStartup = data.providers.filter((provider) => provider.install_status === 'installed_by_startup');
    const unavailable = data.providers.filter((provider) =>
      provider.install_status === 'failed' ||
      provider.install_status === 'unsupported' ||
      provider.install_status === 'cli_missing'
    );
    const installed = data.providers.filter((provider) => provider.superpowers_installed);
    const providerSummary = data.providers
      .map((provider) => `${provider.label}: ${provider.superpowers_installed ? '已就绪' : provider.message ?? '未就绪'}`)
      .join('\n');

    localStorage.setItem(PROVIDER_SUPERPOWERS_NOTICE_KEY, String(data.completed_at));
    if (unavailable.length > 0) {
      toast.warning('Provider Superpowers 检查完成', {
        description: providerSummary,
        duration: 9000,
      });
      return;
    }
    if (installedByStartup.length > 0) {
      toast.success('已自动安装 Provider Superpowers', {
        description: installedByStartup.map((provider) => provider.label).join('、'),
        duration: 8000,
      });
      return;
    }
    if (installed.length > 0) {
      toast.success('Provider Superpowers 已就绪', {
        description: installed.map((provider) => provider.label).join('、'),
        duration: 6000,
      });
    }
  }, [data]);

  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);
