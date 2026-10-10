/**
 * Masque un secret (clé d'API, jeton) dans un texte, sous les trois formes où un message d'erreur le répète :
 * brut, encodé dans une adresse (`?token=…`), et en base64 (en-tête `Authorization: Basic …`).
 * Un secret de moins de quatre caractères n'est pas masqué : il couperait des mots ordinaires.
 */
export function redactSecret(text: string, secret: string, mask: string): string {
  if (!secret) return text;
  let out = text;
  for (const form of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])) {
    if (form.length >= 4) out = out.split(form).join(mask);
  }
  return out;
}
