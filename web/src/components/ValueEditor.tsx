import { useEffect, useState } from 'react';
import { numberToInput, parseNumberInput, sameValue } from '../lib/format';
import type { FieldValue, RecordValue, TemplateField } from '../lib/types';

/**
 * Contrôle de saisie adapté au type de la variable.
 *
 * La saisie manuelle fait autorité sur l'extraction automatique : ces contrôles
 * n'acceptent que des valeurs conformes au type déclaré, de façon qu'une
 * relecture ne puisse pas introduire d'incohérence dans le jeu de données.
 */
export function ValueEditor({
  field,
  value,
  onChange,
  onInvalid,
  id,
}: {
  field: TemplateField;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  /** Signale qu'une saisie en cours n'est pas (ou plus) une valeur recevable, avec la raison. */
  onInvalid?: (message: string | null) => void;
  id?: string;
}) {
  switch (field.type) {
    case 'boolean':
      return (
        <select
          id={id}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(e) =>
            onChange(e.target.value === '' ? null : e.target.value === 'true')
          }
        >
          <option value="">— non renseigné —</option>
          <option value="true">Oui</option>
          <option value="false">Non</option>
        </select>
      );

    case 'enum':
      return (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">— non renseigné —</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );

    case 'multi': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="row" style={{ gap: 10 }} role="group" aria-label={field.label}>
          {field.options.map((option) => {
            const checked = selected.includes(option);
            return (
              <label key={option} className="checkbox" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? selected.filter((v) => v !== option)
                      : [...selected, option];
                    onChange(next.length > 0 ? next : null);
                  }}
                />
                <span>{option}</span>
              </label>
            );
          })}
        </div>
      );
    }

    case 'date':
      return (
        <input
          id={id}
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      );

    case 'number':
    case 'integer':
      return (
        <NumberInput
          id={id}
          integer={field.type === 'integer'}
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
          unit={field.unit}
        />
      );

    default:
      return (
        <input
          id={id}
          type="text"
          value={typeof value === 'string' ? value : value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      );
  }
}

/**
 * Champ numérique indépendant de la langue du navigateur.
 *
 * Le texte tapé est gardé tel quel pendant la saisie (« 12, » reste « 12, »), et seule une valeur
 * lisible est transmise. Une saisie illisible est signalée à côté du champ ET au parent, qui
 * peut alors refuser d'enregistrer plutôt que de garder en silence la dernière valeur valide.
 */
function NumberInput({
  id,
  integer,
  value,
  onChange,
  onInvalid,
  unit,
}: {
  id?: string;
  integer: boolean;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  onInvalid?: (message: string | null) => void;
  unit: string | null;
}) {
  const [draft, setDraft] = useState(() => numberToInput(value));
  const [problem, setProblem] = useState<string | null>(null);

  // La valeur change aussi de l'extérieur (rechargement, annulation) : on s'y recale
  // sauf si elle est précisément ce que la saisie en cours représente.
  useEffect(() => {
    const parsed = parseNumberInput(draft, integer);
    if (parsed.ok && sameValue(parsed.value, value)) return;
    if (!parsed.ok && problem !== null) return; // saisie en cours d'erreur : on ne l'écrase pas
    setDraft(numberToInput(value));
    setProblem(null);
    onInvalid?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Un champ qui disparaît en erreur ne doit pas bloquer l'enregistrement pour toujours.
  useEffect(() => () => onInvalid?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const describedBy = problem && id ? `${id}-erreur` : undefined;
  return (
    <>
      <input
        id={id}
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        placeholder={unit ? `en ${unit}` : undefined}
        aria-invalid={problem !== null}
        aria-describedby={describedBy}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const parsed = parseNumberInput(text, integer);
          if (parsed.ok) {
            setProblem(null);
            onInvalid?.(null);
            onChange(parsed.value);
          } else {
            setProblem(parsed.message);
            onInvalid?.(parsed.message);
          }
        }}
      />
      {problem && (
        <div id={describedBy} className="field-error" role="alert">
          {problem}
        </div>
      )}
    </>
  );
}

/**
 * Indique d'où vient une valeur : règle, modèle, ou décision d'un relecteur.
 *
 * Une valeur relue dit ce que le relecteur en a fait — confirmée, corrigée, vidée — parce que
 * c'est ce qui sépare une extraction qui a été vérifiée de celle qui ne l'a pas été.
 */
export function SourceBadge({ stored }: { stored: RecordValue | undefined }) {
  if (!stored || stored.source === 'empty') return <span className="badge badge-empty">Non renseigné</span>;

  if (stored.source === 'manual') {
    const origin = stored.origin;
    if (!origin) {
      return stored.value === null ? (
        <span className="badge badge-manual" title="Relue : aucune valeur dans le dossier">Vérifié · vide</span>
      ) : (
        <span className="badge badge-manual" title="Valeur saisie par un relecteur">Saisi</span>
      );
    }
    if (stored.value === null) {
      return <span className="badge badge-manual" title="La proposition de l’extraction a été écartée">Vidé</span>;
    }
    return sameValue(stored.value, origin.value) ? (
      <span className="badge badge-manual" title="La proposition de l’extraction a été confirmée">Confirmé</span>
    ) : (
      <span className="badge badge-manual" title="La proposition de l’extraction a été corrigée">Corrigé</span>
    );
  }

  const percent = stored.confidence != null ? ` · ${Math.round(stored.confidence * 100)} %` : '';
  // Une valeur proposée par un modèle se distingue d'une valeur trouvée par
  // une règle : la seconde est reproductible, la première demande une
  // relecture plus attentive.
  if (stored.source === 'llm') {
    return (
      <span
        className="badge badge-llm"
        title="Proposé par le modèle. Indice : 90 % si sa citation a été retrouvée dans le document, 75 % si seule la valeur l’a été. Ce n’est pas une probabilité mesurée — la concordance réelle se lit dans l’onglet Fiabilité des résultats."
      >
        Claude{percent}
      </span>
    );
  }
  return (
    <span
      className="badge badge-auto"
      title="Trouvé par une règle. Indice attribué selon le type de règle (libellé 85 %, expression régulière 80 %, mots-clés 70 %, tag DICOM 95 %), réduit de 3 points par rang de repli. Ce n’est pas une probabilité mesurée — la concordance réelle se lit dans l’onglet Fiabilité des résultats."
    >
      Règle{percent}
    </span>
  );
}
