/**
 * Forme canonique d'un code de dossier.
 *
 * Un code est une clé : deux codes qui s'affichent pareil doivent être le même. Les
 * caractères invisibles (espace de largeur nulle, marque de sens d'écriture, trait d'union
 * conditionnel) et les espaces typographiques s'invitent dans les codes copiés depuis un
 * tableur ou un PDF : « PAT-001 » et le même code avec une espace de largeur nulle glissée
 * au milieu sont deux dossiers que rien, à l'écran, ne distingue.
 *
 * - les invisibles, qui n'occupent aucune place à l'écran, sont retirés ;
 * - les caractères de contrôle et les espaces typographiques deviennent une espace ordinaire.
 */
export function normalizePatientCode(raw: string): string {
  return raw
    .normalize('NFC')
    // Invisibles : largeur nulle, joints, marques et isolats directionnels, trait d'union conditionnel, BOM, annotations interlinéaires.
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g, '')
    // Contrôles C0/C1 et séparateurs de ligne ou de paragraphe, puis espaces insécables, fines, idéographiques…
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
