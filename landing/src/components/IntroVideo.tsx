import { useId } from 'react';
import { INTRO_TRANSCRIPT, INTRO_VIDEO } from '../lib/introVideo';

/**
 * La vidéo de présentation, avec ses commandes : jamais de lecture automatique, et son déroulé écrit juste dessous.
 * `preload="none"` là où elle n'est pas le sujet de la page : rien ne se télécharge avant qu'on la lance.
 */
export function IntroVideo({ preload = 'metadata' }: { preload?: 'none' | 'metadata' }) {
  const captionId = useId();
  return (
    <figure className="intro-video">
      <div className="intro-video-frame">
        <video
          controls
          playsInline
          preload={preload}
          poster={INTRO_VIDEO.poster}
          width={INTRO_VIDEO.width}
          height={INTRO_VIDEO.height}
          aria-label={`Présentation de PubResearcher en ${INTRO_VIDEO.duration}`}
          aria-describedby={captionId}
        >
          <source src={INTRO_VIDEO.src} type={INTRO_VIDEO.type} />
          <source src={INTRO_VIDEO.webm} type={INTRO_VIDEO.webmType} />
          <p>
            Votre navigateur ne lit pas cette vidéo :{' '}
            <a href={INTRO_VIDEO.src} download>
              téléchargez-la (MP4, {INTRO_VIDEO.size})
            </a>
            .
          </p>
        </video>
      </div>
      <figcaption id={captionId}>
        Vidéo sans son, sous-titrée en français · {INTRO_VIDEO.duration} · l’application réelle, sur des dossiers fictifs.
      </figcaption>
      <details className="faq-item compact intro-transcript">
        <summary>Lire le déroulé de la vidéo</summary>
        <ol>
          {INTRO_TRANSCRIPT.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </details>
    </figure>
  );
}
