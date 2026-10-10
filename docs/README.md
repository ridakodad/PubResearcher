# Documentation

Version 1.2.0 · octobre 2026 · en français, comme l'interface.

| Document | Pour qui | Contenu |
|---|---|---|
| [Guide du chercheur](guide-chercheur.md) | Interne, investigateur, ARC | Le parcours en sept étapes : fiche d'exploitation, import, extraction, relecture, résultats, exports, revue bibliographique ; limites à connaître ; messages fréquents |
| [Guide de l'administrateur](guide-administrateur.md) | Qui installe et exploite l'outil | Prérequis, installation, **toutes les variables d'environnement**, exposition sur un réseau (mot de passe, HTTPS, proxy), sauvegarde et restauration, mise à jour, dimensionnement, dépannage |
| [Méthodes et reproductibilité](methodes-et-reproductibilite.md) | Qui publie | Le rapport « Méthodes et traçabilité », paragraphes types (français, anglais), mesurer la fiabilité sur ses dossiers (échantillon, intervalles, effectifs), reproduire une extraction, que conserver |
| [Sécurité et données personnelles](securite-et-donnees.md) | Administrateur, délégué à la protection des données, comité d'éthique | Ce qui sort de la machine, modèle de menaces, protections, ce que l'outil ne fait pas, liste de contrôle d'avant-étude, incidents |
| [Référence de l'API](reference-api.md) | Qui scripte l'outil | Conventions, erreurs, garde-fous, les 53 routes (52 de ressources + la sonde de santé) avec paramètres et exemples, recettes |
| [Architecture](architecture.md) | Qui modifie ou audite le code | Composants, flux, moteur d'extraction, isolation des fichiers, modèle de données, décisions et compromis |
| [Rapport de validation](validation.md) | Tous | Ce qui a été exécuté, les mesures, et **ce qui n'a pas été vérifié** |
| [Revue bibliographique](revue-bibliographique.md) | Chercheur | PubMed et Google Scholar par acteurs Apify : sources, coût, tri, diagramme de flux, exports |
| [Identité visuelle](identite-visuelle.md) | Qui modifie l'interface | Couleurs et contrastes mesurés, police, formes, composants (carte d'en-tête, rail, tuiles), thèmes clair et sombre, comment modifier la charte |
| [Journal des versions](changelog.md) | Tous | Ce qui a changé de la 1.0.0 à la 1.2.0, dont l'unique changement de comportement à connaître (écoute locale par défaut, depuis la 1.1.0) |

Les captures (`img/`) montrent les 24 dossiers fictifs de démonstration (`npm run demo`) ; la relecture y est simulée.

**Une erreur, une étape qui ne se déroule pas comme décrit ?** La documentation a été relue contre le code par deux relecteurs indépendants (variables d'environnement, routes, libellés de l'interface, chiffres, liens) ; elle n'a pas été relue par un chercheur utilisateur : signalez toute erreur.
