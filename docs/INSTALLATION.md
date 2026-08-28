# Installation de Battery Manager

Battery Manager est une **intégration personnalisée Home Assistant**. Elle
s'installe depuis HACS ou en copiant son dossier dans `custom_components`. Elle
ne s'installe pas depuis le Home Assistant Add-on Store, réservé aux
applications exécutées dans des conteneurs séparés.

## Prérequis

- une installation Home Assistant avec accès administrateur ;
- un capteur donnant la puissance active totale au point de raccordement réseau ;
- les intégrations des batteries déjà opérationnelles dans Home Assistant ;
- MQTT configuré dans Home Assistant pour une Hoymiles MS-A2 ;
- une sauvegarde Home Assistant récente avant tout essai de pilotage.

## Installation avec HACS

1. Ouvrez **HACS** dans Home Assistant.
2. Ouvrez le menu en haut à droite puis **Dépôts personnalisés**.
3. Saisissez `https://github.com/RenaudSub/Battery-Manager`.
4. Choisissez la catégorie **Intégration**.
5. Ajoutez le dépôt, ouvrez **Battery Manager**, puis choisissez
   **Télécharger**.
6. Redémarrez complètement Home Assistant.
7. Ouvrez **Paramètres → Appareils et services → Ajouter une intégration**.
8. Recherchez **Battery Manager** ou **Gestionnaire de batteries**.
9. Sélectionnez le capteur de puissance réseau demandé par l'assistant.

Le panneau **Gestion batteries** apparaît ensuite dans la barre latérale. Si
HACS ne trouve pas le dépôt, vérifiez que le dépôt GitHub est public et que son
adresse a été copiée sans suffixe supplémentaire.

## Installation manuelle

1. Téléchargez le code source de la version désirée depuis **Releases** sur
   GitHub.
2. Décompressez l'archive.
3. Copiez le dossier `custom_components/battery_manager` dans
   `/config/custom_components/`.
4. Vérifiez que le chemin final est exactement
   `/config/custom_components/battery_manager/manifest.json`.
5. Redémarrez Home Assistant.
6. Ajoutez ensuite l'intégration depuis **Paramètres → Appareils et services**.

## Mise à jour

Avec HACS, téléchargez la mise à jour proposée puis redémarrez Home Assistant.
En installation manuelle, remplacez entièrement le dossier
`custom_components/battery_manager` par celui de la nouvelle version, sans
effacer les données de Home Assistant.

La configuration utilisateur est enregistrée par Home Assistant dans son
stockage interne. Ne modifiez pas directement les fichiers de `.storage`.

## Désinstallation

1. Désactivez d'abord **Activation du pilotage** pour toutes les batteries et
   vérifiez leur retour au mode choisi.
2. Supprimez l'intégration depuis **Paramètres → Appareils et services**.
3. Redémarrez Home Assistant.
4. Supprimez Battery Manager depuis HACS, ou retirez manuellement
   `/config/custom_components/battery_manager`.

## Dépannage après installation

- **L'intégration n'apparaît pas :** vérifiez le chemin du `manifest.json`,
  redémarrez Home Assistant et videz le cache du navigateur.
- **Le panneau latéral n'apparaît pas :** rechargez complètement la page avec
  `Ctrl+F5`, puis reconnectez-vous si nécessaire.
- **Une ancienne interface reste affichée :** redémarrez Home Assistant et
  videz le cache du navigateur ; le panneau utilise aussi le numéro de version
  dans son URL pour limiter ce problème.
- **Une entité n'est pas proposée :** elle peut tout de même être saisie dans
  le sélecteur. Vérifiez d'abord son identifiant dans **Outils de développement
  → États**.
- **Le gestionnaire reste en attente :** contrôlez la disponibilité du capteur
  réseau et du SOC de chaque batterie. Une valeur `unknown` ou `unavailable`
  interdit volontairement le calcul.

