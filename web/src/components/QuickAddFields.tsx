import { useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { FIELD_TYPE_LABELS, type FieldType, type TemplateField } from '../lib/types';
import { useToast } from './ui';

/**
 * Saisie rapide des variables d'une fiche, pour la construire de zéro.
 *
 * Une ligne suffit : libellé, type (deviné à la frappe), modalités ou unité si besoin, Entrée. Le champ libellé
 * reprend la main aussitôt, pour enchaîner les variables au clavier. Les règles d'extraction sont proposées par le
 * serveur à partir du libellé (synonymes et abréviations médicales) : on les affine ensuite dans l'éditeur complet.
 *
 * Le mode « Coller une liste » crée d'un coup une variable par ligne, avec la même devinette de type ; une ligne
 * « Sexe : Homme / Femme » donne une variable à choix unique.
 */

const TYPES = Object.keys(FIELD_TYPE_LABELS) as FieldType[];

/** Clé technique tirée du libellé (minuscules, sans accents, « _ »), rendue unique. */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  let base =
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50) || 'variable';
  if (!/^[a-z]/.test(base)) base = `v_${base}`;
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Type le plus probable d'après le libellé seul : une proposition, que l'utilisateur corrige d'un clic. */
export function guessType(label: string, options: string[] = []): FieldType {
  const l = fold(label);
  if (options.length > 0) {
    const yesNo = options.length === 2 && options.every((o) => /^(oui|non|o|n|yes|no)$/i.test(o.trim()));
    if (yesNo) return 'boolean';
    return /plusieurs|cocher tout|multiple/.test(l) ? 'multi' : 'enum';
  }
  if (/\bdate\b|\bne\(e\)? le\b|\badmis le\b|\bdu\b.*\bau\b/.test(l)) return 'date';
  if (/^(age|nombre|nb|duree|delai|score|poids|taille|imc|frequence|fc|fr|pas|pad|ta|spo2|saturation|glycemie|temperature)\b|\bnombre de\b|\(.*(mg|g\/|mmol|µmol|umol|ui|%|kg|cm|mm|ans|jours|j|h|min|°c|\/mm3|g\/dl|g\/l)\b.*\)/.test(l))
    return /^(age|nombre|nb|score)\b|\bnombre de\b/.test(l) ? 'integer' : 'number';
  if (/\b(crp|hb|hemoglobine|leucocytes|globules|plaquettes|creatinine|uree|sodium|potassium|albumine|ferritine|procalcitonine|pct|lactates|troponine|bnp|inr|tp|tca|hba1c|ldh|asat|alat|ggt|bilirubine)\b/.test(l))
    return 'number';
  if (/^(antecedent|atcd|diabete|hta|hypertension|tabac|tabagisme|fievre|deces|complication|insuffisance|bpco|asthme|avc|cancer|allergie|grossesse|chirurgie|intubation|transfusion|reprise|recidive|infection)\b|\?$/.test(l))
    return 'boolean';
  if (/^(sexe|genre)\b/.test(l)) return 'enum';
  return 'text';
}

/** « Sexe : Homme / Femme » → libellé et modalités ; « Âge (ans) » → libellé et unité. */
export function parseLine(line: string): { label: string; options: string[]; unit: string | null } {
  let label = line.replace(/^[\s\-–•*·\d.)]+/, '').trim();
  let options: string[] = [];
  const colon = label.match(/^(.+?)\s*[:=]\s*(.+)$/);
  if (colon && /[/|;,]|☐|□/.test(colon[2]!)) {
    label = colon[1]!.trim();
    options = colon[2]!
      .split(/\s*(?:[/|;,]|☐|□|\[ ?\])\s*/)
      .map((o) => o.trim())
      .filter(Boolean);
  } else if (colon && colon[2]!.replace(/[_.\s]/g, '') === '') {
    label = colon[1]!.trim();
  }
  const unitMatch = label.match(/\(([^)]{1,15})\)\s*$/);
  const unit = unitMatch && /[a-zµ%°/]/i.test(unitMatch[1]!) && !/^(oui|non)$/i.test(unitMatch[1]!) ? unitMatch[1]!.trim() : null;
  if (unit) label = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return { label: label.replace(/\s*:\s*$/, ''), options, unit };
}

export function QuickAddFields({
  templateId,
  fields,
  onAdded,
  autoFocus = false,
}: {
  templateId: number;
  fields: TemplateField[];
  onAdded: () => void | Promise<void>;
  autoFocus?: boolean;
}) {
  const toast = useToast();
  const id = useId();
  const labelInput = useRef<HTMLInputElement | null>(null);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [typeTouched, setTypeTouched] = useState(false);
  const [options, setOptions] = useState('');
  const [unit, setUnit] = useState('');
  const [section, setSection] = useState(() => fields.at(-1)?.section ?? 'Général');
  const [busy, setBusy] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');

  const sections = useMemo(() => [...new Set(fields.map((f) => f.section))], [fields]);
  const takenKeys = useMemo(() => new Set(fields.map((f) => f.key)), [fields]);
  const needsOptions = type === 'enum' || type === 'multi';
  const numeric = type === 'number' || type === 'integer';

  async function create(input: { label: string; type: FieldType; options: string[]; unit: string | null }, taken: Set<string>) {
    const key = keyFromLabel(input.label, taken);
    taken.add(key);
    await api.createField(templateId, {
      key,
      label: input.label,
      type: input.type,
      section: section.trim() || 'Général',
      options: input.type === 'enum' || input.type === 'multi' ? input.options : [],
      unit: input.type === 'number' || input.type === 'integer' ? input.unit : null,
    });
  }

  async function addOne() {
    const parsed = parseLine(label);
    if (!parsed.label) return;
    const opts = needsOptions ? options.split(/\s*[,;/|]\s*/).filter(Boolean) : [];
    if (needsOptions && opts.length < 2) {
      toast.error('Indiquez au moins deux modalités, séparées par des virgules.');
      return;
    }
    setBusy(true);
    try {
      await create({ label: parsed.label, type, options: opts, unit: numeric ? unit.trim() || parsed.unit : null }, new Set(takenKeys));
      setLabel('');
      setOptions('');
      setUnit('');
      setType('text');
      setTypeTouched(false);
      await onAdded();
      labelInput.current?.focus();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const bulkLines = bulkText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1);

  async function addBulk() {
    setBusy(true);
    const taken = new Set(takenKeys);
    let created = 0;
    try {
      for (const line of bulkLines) {
        const parsed = parseLine(line);
        if (!parsed.label) continue;
        await create({ ...parsed, type: guessType(parsed.label, parsed.options) }, taken);
        created++;
      }
      toast.success(`${plural(created, 'variable ajoutée', 'variables ajoutées')}. Vérifiez les types proposés.`);
      setBulkText('');
      setBulk(false);
      await onAdded();
    } catch (err) {
      toast.error(`${created > 0 ? `${created} ajoutée(s), puis : ` : ''}${err instanceof ApiError ? err.message : String(err)}`);
      await onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quick-add">
      <div className="quick-add-head">
        <strong>Ajouter des variables</strong>
        <div className="seg" role="tablist" aria-label="Mode de saisie">
          <button role="tab" aria-selected={!bulk} className={!bulk ? 'is-on' : ''} onClick={() => setBulk(false)}>
            Une par une
          </button>
          <button role="tab" aria-selected={bulk} className={bulk ? 'is-on' : ''} onClick={() => setBulk(true)}>
            Coller une liste
          </button>
        </div>
      </div>

      {!bulk ? (
        <form
          className="quick-add-row"
          onSubmit={(e) => {
            e.preventDefault();
            void addOne();
          }}
        >
          <div className="field quick-label">
            <label htmlFor={`${id}-label`}>Libellé</label>
            <input
              id={`${id}-label`}
              type="text"
              ref={labelInput}
              autoFocus={autoFocus}
              value={label}
              placeholder="ex. CRP à l’admission (mg/L)"
              maxLength={200}
              onChange={(e) => {
                setLabel(e.target.value);
                if (!typeTouched) {
                  const p = parseLine(e.target.value);
                  setType(guessType(p.label, p.options));
                  if (p.options.length) setOptions(p.options.join(', '));
                  if (p.unit) setUnit(p.unit);
                }
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-type`}>Type</label>
            <select
              id={`${id}-type`}
              value={type}
              onChange={(e) => {
                setType(e.target.value as FieldType);
                setTypeTouched(true);
              }}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          {needsOptions && (
            <div className="field quick-options">
              <label htmlFor={`${id}-options`}>Modalités</label>
              <input type="text" id={`${id}-options`} value={options} placeholder="Homme, Femme" onChange={(e) => setOptions(e.target.value)} />
            </div>
          )}
          {numeric && (
            <div className="field quick-unit">
              <label htmlFor={`${id}-unit`}>Unité</label>
              <input type="text" id={`${id}-unit`} value={unit} placeholder="mg/L" maxLength={40} onChange={(e) => setUnit(e.target.value)} />
            </div>
          )}
          <div className="field quick-section">
            <label htmlFor={`${id}-section`}>Section</label>
            <input type="text" id={`${id}-section`} value={section} list={`${id}-sections`} maxLength={80} onChange={(e) => setSection(e.target.value)} />
            <datalist id={`${id}-sections`}>
              {sections.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <button type="submit" className="btn-primary" disabled={busy || parseLine(label).label === ''}>
            {busy ? 'Ajout…' : 'Ajouter ↵'}
          </button>
        </form>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <label htmlFor={`${id}-bulk`} className="small secondary">
            Une variable par ligne. « Sexe : Homme / Femme » donne un choix unique, « CRP (mg/L) » un nombre avec son
            unité ; le type est deviné, à vérifier ensuite. Les règles d’extraction sont proposées automatiquement.
          </label>
          <textarea
            id={`${id}-bulk`}
            rows={8}
            value={bulkText}
            placeholder={'Âge (ans)\nSexe : Homme / Femme\nDiabète\nCRP à l’admission (mg/L)\nDate d’admission\nÉvolution : Favorable / Complications / Décès'}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="small muted">Section : </span>
            <input type="text" value={section} list={`${id}-sections`} onChange={(e) => setSection(e.target.value)} style={{ maxWidth: 220 }} aria-label="Section des variables collées" />
            <datalist id={`${id}-sections`}>
              {sections.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <span className="spacer" style={{ marginLeft: 'auto' }} />
            <button className="btn-primary" disabled={busy || bulkLines.length === 0} onClick={() => void addBulk()}>
              {busy ? 'Ajout…' : `Ajouter ${plural(bulkLines.length, 'variable')}`}
            </button>
          </div>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Les règles d’extraction sont proposées à partir du libellé (synonymes et abréviations : « CRP », « Hb », « HTA »…).
        Cliquez sur une variable pour les affiner ou les tester.
      </p>
    </div>
  );
}
