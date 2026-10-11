// Applique le thème choisi avant le premier affichage, pour éviter l'éclair du mauvais thème.
// Fichier à part : la politique de sécurité de l'application interdit les scripts dans la page.
(function () {
  try {
    var theme = localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* stockage inaccessible : thème du système */
  }
})();
