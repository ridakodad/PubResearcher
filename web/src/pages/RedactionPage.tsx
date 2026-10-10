import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ErrorPanel } from '../components/ui';
import { IconAlert, IconWrite } from '../components/icons';

/**
 * Assistant de rédaction.
 *
 * Discuter des résultats d'une cohorte et en tirer un texte publiable demande
 * deux choses que le tableau seul ne donne pas : savoir quels chiffres méritent
 * d'être rapportés, et savoir comment un journal attend qu'ils le soient.
 *
 * L'assistant ne reçoit que des agrégats — effectifs, distributions,
 * définitions des variables. Aucune ligne patient ne quitte la machine pour
 * cet usage : écrire un article n'exige pas de connaître les individus.
 */

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/** Amorces de conversation : elles montrent ce que l'outil sait faire. */
const AMORCES = [
  {
    titre: 'Décrire la population',
    invite:
      "Rédige la section « Résultats » décrivant la population de l’étude : effectifs, " +
      'caractéristiques démographiques et cliniques, en signalant les données manquantes.',
  },
  {
    titre: 'Tableau 1',
    invite:
      'Propose le Tableau 1 de caractéristiques de base, dans la forme attendue par un journal ' +
      'international, et indique pour chaque variable quelle statistique tu retiens et pourquoi.',
  },
  {
    titre: 'Méthodes',
    invite:
      "Rédige la section « Méthodes » selon la déclaration STROBE : type d’étude, population, " +
      'sources de données, variables et leur définition, gestion des données manquantes.',
  },
  {
    titre: 'Ce qui manque',
    invite:
      "Quelles faiblesses vois-tu dans ce recueil ? Qu’est-ce qui empêcherait de publier en " +
      "l’état, et quelles variables faudrait-il recueillir en plus ?",
  },
];

export function RedactionPage() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; cacheReadTokens: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .redactionStatus()
      .then((s) => setAvailable(s.available))
      .catch(() => setAvailable(false));
  }, []);

  // Suivre la rédaction pendant qu'elle s'écrit, sans avoir à faire défiler.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  // Une réponse en cours n'a plus de destinataire si l'on quitte la page.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text: string) {
    const question = text.trim();
    if (question.length === 0 || streaming) return;

    const suite: Message[] = [...messages, { role: 'user', content: question }];
    setMessages([...suite, { role: 'assistant', content: '' }]);
    setDraft('');
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await api.redactionMessage(suite, controller.signal, {
        onDelta: (fragment) =>
          setMessages((current) => {
            const copie = [...current];
            const dernier = copie[copie.length - 1];
            if (dernier?.role === 'assistant') {
              copie[copie.length - 1] = { ...dernier, content: dernier.content + fragment };
            }
            return copie;
          }),
        onDone: (u) => setUsage(u),
        onError: (message) => setError(message),
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Une réponse restée vide (erreur immédiate) n'a rien à faire au fil.
      setMessages((current) =>
        current.filter((m, i) => !(i === current.length - 1 && m.role === 'assistant' && m.content === '')),
      );
    }
  }

  if (available === false) {
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <div className="eyebrow">Instruments</div>
            <h1>Rédaction</h1>
          </div>
        </div>
        <div className="notice notice-warn">
          <IconAlert size={18} />
          <div>
            <strong>Assistant non configuré.</strong> Renseignez{' '}
            <span className="mono">ANTHROPIC_API_KEY</span> dans l’environnement du serveur, puis
            redémarrez l’application. Le reste de l’espace de travail fonctionne sans cette clé.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Instruments</div>
          <h1>Rédaction</h1>
          <p className="sub">
            Discuter des résultats de la cohorte et en tirer un texte publiable. L’assistant ne
            reçoit que des agrégats — effectifs, distributions, définitions des variables — jamais
            les dossiers eux-mêmes.
          </p>
        </div>
        {messages.length > 0 && (
          <div className="page-head-actions">
            <button
              className="btn-quiet"
              onClick={() => {
                setMessages([]);
                setUsage(null);
                setError(null);
              }}
              disabled={streaming}
            >
              Nouveau fil
            </button>
          </div>
        )}
      </div>

      {messages.length === 0 ? (
        <div className="chat-start">
          <span className="tool-icon" aria-hidden="true">
            <IconWrite />
          </span>
          <h2>Par quoi commencer ?</h2>
          <p className="secondary" style={{ maxWidth: '62ch' }}>
            L’assistant connaît vos effectifs et vos distributions. Il n’invente aucun chiffre, ne
            produit aucun test statistique sans les données individuelles — qu’il n’a pas — et
            signale ce qui fragiliserait une interprétation.
          </p>
          <div className="bento" style={{ marginTop: 20, width: '100%' }}>
            {AMORCES.map((a) => (
              <button
                key={a.titre}
                className="tool-card b-6"
                style={{ textAlign: 'left' }}
                onClick={() => void send(a.invite)}
              >
                <span className="tool-title">{a.titre}</span>
                <span className="tool-desc">{a.invite}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="chat-thread">
          {messages.map((m, i) => (
            <article key={i} className={m.role === 'user' ? 'chat-turn chat-user' : 'chat-turn'}>
              <div className="chat-role">{m.role === 'user' ? 'Vous' : 'Claude'}</div>
              <div className="chat-body">
                {m.content}
                {streaming && i === messages.length - 1 && m.role === 'assistant' && (
                  <span className="chat-caret" aria-label="rédaction en cours" />
                )}
              </div>
            </article>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {error && <ErrorPanel message={error} />}

      <div className="chat-compose">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Posez une question sur la cohorte, ou demandez une section rédigée…"
          aria-label="Votre message"
          rows={3}
          onKeyDown={(e) => {
            // Entrée envoie, Maj+Entrée passe à la ligne : on rédige souvent
            // des demandes de plusieurs phrases.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <div className="row">
          <span className="small muted">
            {usage
              ? `${usage.inputTokens.toLocaleString('fr-FR')} jetons en entrée ` +
                `(${usage.cacheReadTokens.toLocaleString('fr-FR')} depuis le cache), ` +
                `${usage.outputTokens.toLocaleString('fr-FR')} en sortie`
              : 'Entrée pour envoyer, Maj+Entrée pour aller à la ligne'}
          </span>
          <div className="spacer" />
          {streaming ? (
            <button onClick={() => abortRef.current?.abort()}>Interrompre</button>
          ) : (
            <button
              className="btn-primary"
              onClick={() => void send(draft)}
              disabled={draft.trim().length === 0}
            >
              Envoyer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
