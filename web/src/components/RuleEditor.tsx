import type { DocKind, ExtractionRule, FieldType, RuleSource } from '../lib/types';
import { StringListEditor } from './ui';

const RULE_LABELS: Record<ExtractionRule['kind'], string> = {
  label: 'Libellé suivi de la valeur',
  keyword: 'Présence de mots-clés',
  regex: 'Expression régulière',
  dicom: 'Tag DICOM',
};

const RULE_HELP: Record<ExtractionRule['kind'], string> = {
  label:
    "Cherche « Libellé : valeur » dans les documents. Les accents, la casse et les apostrophes sont ignorés : « Âge », « Age » et « AGE » se valent.",
  keyword:
    "Émet une valeur fixe si l’un des termes apparaît. Les termes d’exclusion évitent les faux positifs du type « pas de diabète ».",
  regex:
    "Pour les cas que le libellé ne couvre pas. Le premier groupe entre parenthèses est capturé. Les accents sont ignorés.",
  dicom: "Lit un tag des fichiers DICOM, par mot-clé (PatientAge) ou par code (00101010).",
};

const DOC_KIND_OPTIONS: { value: DocKind; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'Word' },
  { value: 'image', label: 'Image' },
  { value: 'dicom', label: 'DICOM' },
  { value: 'text', label: 'Texte' },
];

export function makeRule(kind: ExtractionRule['kind']): ExtractionRule {
  switch (kind) {
    case 'label':
      return { kind: 'label', labels: [] };
    case 'keyword':
      return { kind: 'keyword', any: [], none: [], emit: true };
    case 'regex':
      return { kind: 'regex', pattern: '', group: 1 };
    case 'dicom':
      return { kind: 'dicom', tag: '' };
  }
}

/**
 * Édition d'une règle d'extraction.
 *
 * Les règles sont évaluées dans l'ordre : la première qui produit une valeur
 * conforme au type de la variable l'emporte. Les suivantes servent de repli,
 * ce qui permet d'écrire une règle précise puis une règle plus large.
 */
export function RuleEditor({
  rule,
  fieldType,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  rule: ExtractionRule;
  fieldType: FieldType;
  index: number;
  total: number;
  onChange: (rule: ExtractionRule) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: 14,
        background: 'var(--surface-1)',
      }}
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="badge">
          {index + 1}
          {index === 0 ? ' · règle principale' : ' · repli'}
        </span>
        <strong style={{ fontSize: '0.875rem' }}>{RULE_LABELS[rule.kind]}</strong>
        <div className="spacer" />
        <button
          className="btn-icon btn-sm"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label="Monter la règle"
          title="Monter"
        >
          ↑
        </button>
        <button
          className="btn-icon btn-sm"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          aria-label="Descendre la règle"
          title="Descendre"
        >
          ↓
        </button>
        <button className="btn-sm btn-danger" onClick={onRemove}>
          Retirer
        </button>
      </div>

      <p className="small muted" style={{ marginBottom: 12 }}>
        {RULE_HELP[rule.kind]}
      </p>

      {rule.kind === 'label' && (
        <>
          <div className="field">
            <label>Libellés reconnus</label>
            <StringListEditor
              values={rule.labels}
              onChange={(labels) => onChange({ ...rule, labels })}
              placeholder="Âge, Age du patient…"
              ariaLabel="Nouveau libellé"
            />
            <div className="field-hint">
              Ajoutez toutes les formulations rencontrées dans vos documents.
            </div>
          </div>
          <div className="field">
            <label htmlFor={`maxlen-${index}`}>Longueur maximale capturée</label>
            <input
              id={`maxlen-${index}`}
              type="number"
              min={1}
              max={500}
              value={rule.maxLength ?? 120}
              onChange={(e) => onChange({ ...rule, maxLength: Number(e.target.value) })}
              style={{ maxWidth: 140 }}
            />
            <div className="field-hint">
              Nombre de caractères lus après le libellé. Augmentez-le pour du texte libre.
            </div>
          </div>
        </>
      )}

      {rule.kind === 'keyword' && (
        <>
          <div className="field">
            <label>Termes déclencheurs</label>
            <StringListEditor
              values={rule.any}
              onChange={(any) => onChange({ ...rule, any })}
              placeholder="diabète, diabétique…"
              ariaLabel="Nouveau terme déclencheur"
            />
            <div className="field-hint">
              Un terme ne se lit jamais au milieu d’un mot (« mme » n’est pas dans « homme »), et un
              terme de quatre lettres ou moins doit être un mot entier (« hta » n’est pas « HTAP »).
              Les formes fléchies doivent être listées : « diabète » ne couvre pas « diabétique » ;
              une racine plus longue (« diabet ») couvre les deux.
            </div>
          </div>
          <div className="field">
            <label>Termes d’exclusion</label>
            <StringListEditor
              values={rule.none ?? []}
              onChange={(none) => onChange({ ...rule, none })}
              placeholder="pas de, absence de, sans, non…"
              ariaLabel="Nouveau terme d’exclusion"
            />
            <div className="field-hint">
              Annule la détection si l’un de ces termes précède le terme trouvé dans la même
              proposition. Dès qu’une exclusion est déclarée, la règle lit aussi ce qui suit le
              terme : « (-) », « : non », « exclu », « négatif ».
            </div>
          </div>
          <div className="field">
            <label>Contextes à ignorer</label>
            <StringListEditor
              values={rule.skip ?? []}
              onChange={(skip) => onChange({ ...rule, skip })}
              placeholder="mère, père, famille, frère…"
              ariaLabel="Nouveau contexte à ignorer"
            />
            <div className="field-hint">
              Une mention dont la phrase contient l’un de ces termes n’est ni retenue ni niée :
              « sa mère est diabétique » ne dit rien du diabète du patient. Pensez aux antécédents
              familiaux.
            </div>
          </div>
          <div className="field">
            <label htmlFor={`emit-${index}`}>Valeur émise en cas de correspondance</label>
            {fieldType === 'boolean' ? (
              <select
                id={`emit-${index}`}
                value={rule.emit === false ? 'false' : 'true'}
                onChange={(e) => onChange({ ...rule, emit: e.target.value === 'true' })}
                style={{ maxWidth: 200 }}
              >
                <option value="true">Oui</option>
                <option value="false">Non</option>
              </select>
            ) : (
              <input
                id={`emit-${index}`}
                type="text"
                value={
                  typeof rule.emit === 'string'
                    ? rule.emit
                    : rule.emit === null
                      ? ''
                      : String(rule.emit)
                }
                onChange={(e) => onChange({ ...rule, emit: e.target.value })}
                placeholder="Scanner"
              />
            )}
          </div>

          <div className="field">
            <label htmlFor={`emit-neg-${index}`}>Valeur émise si le terme n’apparaît que nié</label>
            {fieldType === 'boolean' ? (
              <select
                id={`emit-neg-${index}`}
                value={
                  rule.emitIfNegated === undefined ? '' : rule.emitIfNegated === true ? 'true' : 'false'
                }
                onChange={(e) =>
                  onChange({
                    ...rule,
                    emitIfNegated: e.target.value === '' ? undefined : e.target.value === 'true',
                  })
                }
                style={{ maxWidth: 260 }}
              >
                <option value="">— laisser vide —</option>
                <option value="false">Non</option>
                <option value="true">Oui</option>
              </select>
            ) : (
              <input
                id={`emit-neg-${index}`}
                type="text"
                value={typeof rule.emitIfNegated === 'string' ? rule.emitIfNegated : ''}
                onChange={(e) =>
                  onChange({ ...rule, emitIfNegated: e.target.value || undefined })
                }
                placeholder="— laisser vide —"
              />
            )}
            <div className="field-hint">
              « Pas de diabète » documente une absence : la renseigner en « Non » plutôt que de
              laisser la case vide distingue l’absence recherchée de la donnée manquante.
            </div>
          </div>

          {fieldType === 'boolean' && (
            <div className="field">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={rule.history === 'exclude'}
                  onChange={(e) => onChange({ ...rule, history: e.target.checked ? 'exclude' : undefined })}
                />
                Ignorer les mentions placées dans les antécédents
              </label>
              <div className="field-hint">
                Pour une variable de l’épisode en cours (fièvre, complication) : « Antécédents :
                pneumopathie fébrile » ne dit rien de ce séjour. À laisser décoché pour une maladie
                chronique, qui se documente justement dans les antécédents. Dans tous les cas, une
                hypothèse (« suspicion de », « ? »), un épisode clos (« en 2019 », « résolutif ») ou
                une mention « non renseigné » ne donnent jamais « Oui ».
              </div>
            </div>
          )}
        </>
      )}

      {rule.kind === 'regex' && (
        <>
          <div className="field">
            <label htmlFor={`pattern-${index}`}>Motif</label>
            <input
              id={`pattern-${index}`}
              type="text"
              className="mono"
              value={rule.pattern}
              onChange={(e) => onChange({ ...rule, pattern: e.target.value })}
              placeholder="patient de (\d{1,3}) ans"
            />
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1, minWidth: 120 }}>
              <label htmlFor={`group-${index}`}>Groupe capturé</label>
              <input
                id={`group-${index}`}
                type="number"
                min={0}
                max={20}
                value={rule.group ?? 1}
                onChange={(e) => onChange({ ...rule, group: Number(e.target.value) })}
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 120 }}>
              <label htmlFor={`flags-${index}`}>Drapeaux</label>
              <input
                id={`flags-${index}`}
                type="text"
                className="mono"
                value={rule.flags ?? ''}
                onChange={(e) => onChange({ ...rule, flags: e.target.value })}
                placeholder="m, s…"
              />
            </div>
          </div>
        </>
      )}

      {rule.kind === 'dicom' && (
        <div className="field">
          <label htmlFor={`tag-${index}`}>Tag</label>
          <input
            id={`tag-${index}`}
            type="text"
            className="mono"
            value={rule.tag}
            onChange={(e) => onChange({ ...rule, tag: e.target.value })}
            placeholder="PatientAge"
          />
          <div className="field-hint">
            Exemples : PatientAge, PatientSex, StudyDate, Modality, StudyDescription.
          </div>
        </div>
      )}

      {rule.kind !== 'dicom' && (
        <details style={{ marginTop: 4 }}>
          <summary className="small secondary" style={{ cursor: 'pointer' }}>
            Restreindre la recherche
          </summary>
          <div style={{ marginTop: 10 }}>
            <div className="field">
              <label htmlFor={`source-${index}`}>Chercher dans</label>
              <select
                id={`source-${index}`}
                value={rule.source ?? 'text'}
                onChange={(e) => onChange({ ...rule, source: e.target.value as RuleSource })}
                style={{ maxWidth: 260 }}
              >
                <option value="text">Le texte des documents</option>
                <option value="filename">Le nom du fichier</option>
                <option value="dicom">Les métadonnées DICOM</option>
              </select>
            </div>
            <div className="field">
              <label>Types de documents</label>
              <div className="row" style={{ gap: 12 }}>
                {DOC_KIND_OPTIONS.map((option) => {
                  const selected = rule.docKinds ?? [];
                  const checked = selected.includes(option.value);
                  return (
                    <label key={option.value} className="checkbox" style={{ marginBottom: 0 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? selected.filter((k) => k !== option.value)
                            : [...selected, option.value];
                          onChange({ ...rule, docKinds: next.length > 0 ? next : undefined });
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  );
                })}
              </div>
              <div className="field-hint">
                Aucun type coché : la règle s’applique à tous les documents.
              </div>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

export { RULE_LABELS };
