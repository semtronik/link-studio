/**
 * Erreur structurée renvoyée par la commande Tauri `serial_connect`.
 * Miroir du `ConnectError` Rust (sérialisé via serde, tag = "code").
 *
 * Le backend ne produit JAMAIS de message localisé. Il renvoie un code
 * sémantique + le port concerné + un raw message OS pour debug.
 * Le frontend mappe ensuite `code` → message utilisateur (FR pour V1,
 * facilement traduisible plus tard).
 */
export type ConnectErrorCode =
  | 'port_busy'
  | 'port_not_found'
  | 'permission_denied'
  | 'invalid_settings'
  | 'other';

export interface ConnectError {
  code: ConnectErrorCode;
  port: string;
  raw: string;
}

/**
 * Type guard : vérifie qu'un objet inconnu (typiquement un `err` reçu
 * dans un `catch` de commande Tauri) est bien un `ConnectError` structuré.
 * Tauri sérialise les `Err(T: Serialize)` en JSON pur — l'objet renvoyé
 * contient `code`/`port` au top-level.
 */
export function isConnectError(err: unknown): err is ConnectError {
  if (typeof err !== 'object' || err === null) return false;
  const obj = err as Record<string, unknown>;
  return (
    typeof obj.code === 'string' &&
    typeof obj.port === 'string' &&
    typeof obj.raw === 'string'
  );
}

export type Platform = 'windows' | 'macos' | 'linux' | 'other';

/**
 * Mapping code → message utilisateur en français. Certains messages
 * varient selon la plateforme (notamment `permission_denied` :
 * Linux mentionne le groupe `dialout`, macOS l'autorisation système).
 * Le frontend récupère la plateforme via la commande Tauri `get_platform`.
 *
 * Externalisable dans un système i18n quand une 2e langue sera ajoutée.
 */
function buildMessages(_platform: Platform): Record<ConnectErrorCode, (e: ConnectError) => { title: string; detail: string }> {
  return {
    port_busy: (e) => ({
      title: 'Port occupé',
      detail: `Le port ${e.port} est déjà utilisé par une autre application.`,
    }),
    port_not_found: (e) => ({
      title: 'Port introuvable',
      detail: `Le port ${e.port} n'est plus accessible.`,
    }),
    permission_denied: (e) => ({
      title: 'Permissions insuffisantes',
      detail: `Accès au port ${e.port} refusé.`,
    }),
    invalid_settings: (e) => ({
      title: 'Configuration série invalide',
      detail: `Paramètres de connexion refusés sur ${e.port}.`,
    }),
    other: (e) => ({
      title: 'Échec connexion',
      detail: `Impossible de se connecter à ${e.port}.`,
    }),
  };
}

/**
 * Convertit un `ConnectError` en titre + détail prêts à afficher dans
 * un toast. Pure, sans effet de bord. La plateforme par défaut "other"
 * produit des messages génériques (cas où `get_platform` n'a pas encore
 * répondu au moment de l'erreur).
 */
export function formatConnectError(err: ConnectError, platform: Platform = 'other'): { title: string; detail: string } {
  return buildMessages(platform)[err.code](err);
}

/**
 * Helper "tout-en-un" : prend n'importe quel `err` reçu dans un `catch`,
 * détecte si c'est un `ConnectError` structuré, et renvoie le titre +
 * détail localisés. Pour les erreurs non structurées (string brute,
 * Error JS, etc.) renvoie un message générique avec le détail brut —
 * pas de blocage UX, l'utilisateur voit toujours quelque chose
 * d'exploitable même si la classification a raté.
 */
export function describeConnectError(err: unknown, port: string, platform: Platform = 'other'): { title: string; detail: string } {
  if (isConnectError(err)) {
    return formatConnectError(err, platform);
  }
  // Fallback pour erreurs non structurées (rare : code legacy, bug
  // de sérialisation côté backend, etc.). On affiche le raw OS pour
  // que l'utilisateur ait quelque chose d'actionable, même imparfait.
  const raw = typeof err === 'string'
    ? err
    : (err instanceof Error ? err.message : String(err));
  return {
    title: 'Échec connexion',
    detail: `Impossible de se connecter à ${port}. Détail technique : ${raw}`,
  };
}
