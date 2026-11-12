import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as certificates from '@techieutils/api-workbench-common/client-certificates';
import { mqttOriginURL } from '@techieutils/api-workbench-common/protocol-config';
import type { ApiRequest, AppSettings } from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { requestProtocol } from './protocols';
import { useUiStore } from './ui';
import { useWorkspaceStore } from './workspace';

/** Appearance, the Settings screen's navigation, and client certificates. */
export const useSettingsStore = defineStore('settings', () => {
  const workspace = useWorkspaceStore();
  const section = ref<SettingsSection>('General');

  const clientCertificates = (): ClientCertificate[] => workspace.state.clientCertificates || [];
  /** The certificate payload for a request URL, when an enabled entry matches. */
  function requestClientCertificate(url: string) {
    const match = certificates.matchClientCertificate(clientCertificates(), url);
    return match ? certificates.certificatePayload(match) : undefined;
  }
  /** The URL a request's TLS connection uses; TLS gRPC targets are host:port. */
  function requestCertificateURL(request: ApiRequest): string {
    const url = workspace.resolve(request.url).trim();
    if (requestProtocol(request) === 'grpc') return request.grpc?.tls ? `https://${url}` : '';
    if (requestProtocol(request) === 'mqtt')
      try {
        return mqttOriginURL(url).toString();
      } catch {
        return '';
      }
    return url;
  }
  function setWorkspaceCA(pem: string): void {
    const settings = workspace.settings();
    workspace.state.settings = {
      ...settings,
      httpSettings: { ...settings.httpSettings, caCertificates: pem },
    };
    workspace.persist();
    render();
  }

  // Appearance
  function applyTheme(theme: AppSettings['theme']): void {
    const root = document.documentElement;
    root.dataset.theme =
      theme === 'system'
        ? matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    const resolved = root.dataset.theme as 'light' | 'dark';
    document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((link) => {
      const size = link.sizes.contains('16x16') ? 16 : 32;
      link.type = 'image/png';
      link.href = `assets/favicon-${resolved}-${size}.png`;
    });
    void window.workbench?.setTheme?.(resolved);
  }
  function applyPreferences(): void {
    const config = workspace.settings();
    const root = document.documentElement;
    applyTheme(config.theme);
    // public/startup-theme.js reads this before first paint to theme the initialization screen.
    try {
      localStorage.setItem('api-workbench-theme', config.theme);
    } catch {
      /* The initialization screen falls back to dark. */
    }
    root.dataset.density = config.density;
    root.dataset.fontSize = String(config.editorFontSize);
    root.dataset.wrap = String(config.wordWrap);
  }
  // A System theme follows the OS, including the choice being previewed in Settings.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    const previewed =
      useUiStore().view === 'Settings'
        ? document.querySelector<HTMLSelectElement>('#settings-form [name=theme]')?.value
        : undefined;
    if ((previewed || workspace.settings().theme) === 'system') applyTheme('system');
  });
  return {
    section,
    clientCertificates,
    requestClientCertificate,
    requestCertificateURL,
    setWorkspaceCA,
    applyTheme,
    applyPreferences,
  };
});
