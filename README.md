# Gestionnaire de batteries pour Home Assistant

**Battery Manager v0.6.0** est une intégration locale destinée à centraliser la
surveillance, la programmation et le pilotage collectif de plusieurs batteries
de marques différentes dans Home Assistant.

> Battery Manager est une **intégration personnalisée**, installable avec HACS
> ou manuellement dans `custom_components`.

🌐 [Site officiel de Battery Manager](https://logisub.com/battery-manager.html)

## Fonctionnalités présentes v0.6.1

### Surveillance et vue d’ensemble

- Panneau **Gestion batteries** dans la barre latérale de Home Assistant et suivi de plusieurs batteries depuis une seule interface.
- Prise en charge des **Marstek par entités Home Assistant**, des **Hoymiles MS-A2 par MQTT** et des batteries génériques en surveillance seule.
- Cercle de SOC, état de connexion, puissance instantanée et sens du flux pour chaque batterie.
- Affichage distinct du mode actif, de la consigne calculée et des commandes réellement transmises.
- Puissance réseau instantanée, moyennes glissantes sur une et quinze minutes et flèche de tendance.
- Mesures AC/DC, rendement de conversion, températures minimale et maximale du jour, état de l’onduleur et compteurs d’énergie selon les entités disponibles.
- Énergie réellement stockée, énergie chargée et déchargée dans la journée, cycles et tensions minimale/maximale des cellules pour les Marstek compatibles.
- Estimation de l’heure d’atteinte du SOC maximal, actualisée chaque minute à partir d’une moyenne glissante et des paliers de charge.
- Ouverture de l’historique Home Assistant au clic sur les mesures et commandes associées à une entité.
- Sections **Commandes réelles** et **Consigne en cours** repliables ; leur ouverture est mémorisée par batterie, navigateur et appareil.

### Pilotage collectif et modes rapides

- Autoconsommation collective calculée depuis le capteur global de puissance réseau, avec répartition des consignes entre les batteries pilotées.
- Charge solaire collective pour absorber uniquement le surplus, sans provoquer de décharge.
- Menu rapide **Gestion** par batterie : Planificateur, Charge, Autoconsommation collective, Autoconsommation native Marstek, Charge solaire, En attente, Désactivé et Backup Marstek lorsque configuré.
- Les modes rapides remplacent temporairement la programmation sans modifier les créneaux et restent enregistrés après un redémarrage.
- Réglages du signe des puissances, correction du zéro réseau, zone morte, hystérésis, compensations de charge/décharge et retransmission des commandes.
- Maintien du contrôle MQTT de la MS-A2 par publication périodique des consignes.

### Planificateur hebdomadaire et profils

- Programmation sur **sept jours**, avec **96 créneaux de 15 minutes par jour**, affichée côte à côte pour les batteries.
- Actions Charge, Décharge, Autoconsommation collective, Charge solaire collective, Standby, Retour au mode par défaut et Autoconsommation native Marstek.
- Puissances maximales de charge/décharge et seuils SOC configurables dans la programmation.
- Sélection de plages par glisser-déposer, d’une journée, d’une heure sur toute la semaine ou de la semaine complète.
- Trois profils fournis : **Ensoleillé, Nuageux et Pluvieux**, avec création de profils personnalisés.
- Sélection globale du profil en mode manuel ou automatique et migration de l’ancien planning journalier vers les profils météo.
- Export et import JSON des paramètres de planification.

### Gestion météo

- Analyse des prévisions horaires d’une entité météo Home Assistant, avec décalage de prévision, intervalle d’actualisation et hystérésis configurables.
- Capteur de couverture nuageuse prioritaire lorsqu’il est configuré, seuils d’interprétation et sélection automatique du profil météo.
- Seuil de précipitations configurable, fixé à **0,5 mm/h par défaut** : une condition `rainy` sous ce seuil laisse la couverture nuageuse déterminer le profil.
- Priorité au profil Pluvieux pour les phénomènes importants : pluie forte, orage avec pluie, grêle ou neige mêlée de pluie.
- Repli sur la condition météo lorsque la quantité de précipitations n’est pas fournie.
- Nouveau **Seuil solaire utile** utilisant une entité de rayonnement en `W/m²` ou une entité d’éclairement en lux avec facteur de conversion configurable.
- Correction possible du profil `Nuageux` vers `Ensoleillé` lorsque le seuil solaire est dépassé de manière continue.
- Choix des conditions météo pouvant être corrigées ; `Partiellement nuageux` et `Nuageux` sont sélectionnées par défaut.
- Délai de validation configurable de 1 à 30 minutes et maintien de la correction de 5 à 45 minutes afin d’éviter les changements de profil au passage d’un nuage.
- Les précipitations, orages, chutes de grêle, chutes de neige et conditions exceptionnelles restent toujours prioritaires sur la correction solaire.
- Diagnostic détaillé : prévision analysée, couverture et source, précipitations prévues, seuil appliqué, rayonnement converti, valeur brute, état de la correction, profil initial et raison du profil retenu.
- Traduction des conditions météo en français, anglais et espagnol dans les associations, tout en conservant les identifiants techniques Home Assistant.
- Actualisation manuelle du diagnostic, y compris lorsqu’un profil manuel est sélectionné.
- Le rayonnement local devient prioritaire dans les deux sens : au-dessus du seuil il peut imposer le profil `Ensoleillé`, tandis qu’en dessous du seuil il peut imposer le profil `Nuageux` après le délai de maintien.
- Les conditions `Pluvieux` et `Orageux avec pluie` peuvent être sélectionnées comme conditions corrigibles : un rayonnement réellement élevé peut alors imposer `Ensoleillé`, mais leur profil pluvieux initial reste conservé lorsque le rayonnement demeure sous le seuil.

### Configuration, protections et Backup

- Détection automatique des batteries **Marstek Venus Modbus**, récupération de leurs entités et diagnostic des entités disponibles, indisponibles, inconnues ou désactivées.
- Choix du modèle avec illustration : **Marstek Venus E 3.0**, **Hoymiles MS-A2** ou Générique ; ce choix ne modifie pas les paramètres de pilotage.
- Limites matérielles de puissance, SOC minimal/maximal et seuils de reprise par batterie.
- Jusqu’à **huit paliers de charge selon le SOC**, avec quatre paliers proposés par défaut et illustration des limites configurées.
- Suspension du calcul lorsque les mesures indispensables de puissance réseau ou de SOC sont indisponibles.
- Protection de perte du Grid : retour au mode configuré après 60 secondes de tension numérique hors de 200 à 250 V ; reprise optionnelle de la Programmation au retour du Grid dans un délai maximal de quatre heures.
- Sécurité **Backup Marstek** : arrêt des commandes et verrouillage de la gestion rapide lorsque `Backup Function` est actif.
- Reprise du mode précédent après désactivation du Backup et maintien d’une tension Grid entre 200 et 250 V pendant 30 secondes.
- Panneau **Actions** pour désactiver une entité à l’entrée en Backup et restaurer facultativement son état initial au retour du Grid ; cet état est conservé pendant les redémarrages de Home Assistant.

### Notifications

- Panneau **Notifications** avec création, modification, test et suppression des destinations `notify.mobile_app_*`.
- Catalogue de **37 notifications**, avec choix des batteries, seuils et destinataires ; aucun envoi tant qu’aucun destinataire n’est sélectionné.
- Un créneau quotidien par destination, **07:00–22:00 par défaut**, sans passage à minuit.
- Seuils liés à la Configuration lorsque disponibles, avec personnalisation et possibilité de rétablir le lien.
- Confirmation, délai minimal entre alertes et durée de réarmement configurable, mémorisée par batterie et destination.
- Réarmement de **14 heures par défaut** pour les notifications de début de charge et de décharge.
- Envoi d’une alerte persistante à l’ouverture du créneau uniquement si sa condition est encore présente ; journalisation unique des notifications inhibées pendant un même épisode.

### Journaux, interface et documentation

- Panneau **Journaux** : Consignes, Planificateur, Gestion météo, Notifications et Actions utilisateurs.
- Historique persistant avec date, heure, type et contenu, recherche et pagination.
- Rétention limitée à **30 jours et 50 Mo au total**, avec suppression automatique des entrées les plus anciennes.
- Interface en **français, anglais et espagnol**, adaptée aux ordinateurs, tablettes, téléphones et au thème sombre.
- Navigation par roue dentée et panneau **À propos** avec documentation intégrée : installation, configuration, modes, planification, météo, protections, Backup, notifications, journaux et dépannage.

## Captures d’écran

### Vue d’ensemble

[![Vue d’ensemble de Battery Manager](https://logisub.com/assets/bm-vue-ensemble.jpg?v=0.5.5)](https://logisub.com/assets/bm-vue-ensemble.jpg?v=0.5.5)

### Planificateur

[![Planificateur de Battery Manager](https://logisub.com/assets/bm-planificateur.jpg?v=0.5.5)](https://logisub.com/assets/bm-planificateur.jpg?v=0.5.5)

### Configuration générale

[![Configuration générale de Battery Manager](https://logisub.com/assets/bm-configuration-generale.jpg?v=0.5.5)](https://logisub.com/assets/bm-configuration-generale.jpg?v=0.5.5)

### Protections et paliers de charge

[![Protections et paliers de charge](https://logisub.com/assets/bm-configuration-paliers.jpg?v=0.5.5)](https://logisub.com/assets/bm-configuration-paliers.jpg?v=0.5.5)

### Gestion des profils météo

[![Gestion des profils météo](https://logisub.com/assets/bm-confimeteo.jpg?v=0.5.61)](https://logisub.com/assets/bm-confimeteo.jpg?v=0.5.61)

### Gestion des notifications

[![Gestion des notifications](https://logisub.com/assets/bm-notifications.jpg?v=0.5.5)](https://logisub.com/assets/bm-notifications.jpg?v=0.5.5)

### Gestion des journaux

[![Gestion des journaux](https://logisub.com/assets/bm-journaux.jpg?v=0.5.5)](https://logisub.com/assets/bm-journaux.jpg?v=0.5.5)

## Avertissement bêta

La gestion réelle est **désactivée par défaut** pour chaque batterie. Commencez
en surveillance seule et vérifiez les noms des modes, le signe des puissances,
les limites et les réactions du matériel avant d'autoriser les commandes.

Cette intégration n'est pas un dispositif de sécurité électrique et ne remplace
pas les protections du BMS, les disjoncteurs ou les limites du constructeur.

## Documentation

- [Installation, mise à jour et dépannage](docs/INSTALLATION.md)
- [Configuration détaillée et choix des entités](docs/CONFIGURATION.md)
- [Guide Hoymiles MS-A2 et sujets MQTT](docs/HOYMILES_MQTT.md)
- [Signaler un problème](https://github.com/RenaudSub/Battery-Manager/issues)

Une documentation intégrée est également accessible depuis le panneau **À propos**.

## Installation avec HACS

1. Ouvrir **HACS → menu → Dépôts personnalisés**.
2. Ajouter `https://github.com/RenaudSub/Battery-Manager` dans la catégorie **Intégration**.
3. Ouvrir **Battery Manager**, puis choisir **Télécharger**.
4. Redémarrer Home Assistant.
5. Ouvrir **Paramètres → Appareils et services → Ajouter une intégration**.
6. Rechercher **Battery Manager** ou **Gestionnaire de batteries** et choisir le capteur global de puissance réseau.
7. Ouvrir le panneau **Gestion batteries** dans la barre latérale.

## Installation manuelle

1. Copier `custom_components/battery_manager` dans le dossier
   `/config/custom_components/` de Home Assistant.
2. Redémarrer Home Assistant.
3. Ouvrir **Paramètres → Appareils et services → Ajouter une intégration**.
4. Rechercher **Battery Manager** ou **Gestionnaire de batteries**.
5. Sélectionner le capteur global de puissance réseau.
6. Ouvrir le nouveau panneau **Gestion batteries** dans la barre latérale.

## Convention du capteur réseau

Par défaut :

- valeur positive : importation depuis le réseau ;
- valeur négative : injection vers le réseau.

L'option d'inversion permet d'utiliser un capteur ayant la convention opposée.

## Hoymiles MS-A2

Exemple avec le numéro de série `280024365727` :

```text
Sujet mode EMS
homeassistant/select/MSA-280024365727/ems_mode/command

Sujet consigne
homeassistant/number/MSA-280024365727/power_ctrl/set
```

Convention utilisée par la MS-A2 :

- puissance négative : charge ;
- puissance positive : décharge.

L'intégration envoie `mqtt_ctrl` puis renouvelle la consigne. Une alternance de
0,1 W est volontaire afin d'éviter le retour automatique à la logique interne.

## Marstek

L'adaptateur Marstek utilise deux sélecteurs distincts :

- `User Work Mode`, réglé sur `Manual` pendant le pilotage ;
- `Force Mode`, réglé sur `Charge`, `Discharge` ou `Standby`.

Le mode « Autoconsommation » du programme est calculé collectivement depuis le
capteur réseau choisi dans l'intégration. Il ne sélectionne donc pas le mode
Marstek natif `Self Consumption`, car chaque batterie agirait alors de son côté
et contournerait la répartition collective.

Avant d'activer les commandes :

1. essayer manuellement chaque option de mode dans Home Assistant ;
2. vérifier l'entité de consigne de charge ;
3. vérifier l'entité de consigne de décharge ;
4. limiter les premiers essais à une faible puissance ;
5. conserver l'application constructeur disponible pour reprendre la main.

## Priorité des limites

La puissance appliquée est la plus faible parmi :

1. la demande du programme ;
2. la limite matérielle configurée ;
3. le palier correspondant au SOC actuel.

À partir du SOC maximal, la charge est interdite. Elle reprend au seuil de
reprise. Le même principe est appliqué à la décharge au SOC minimal.

## Version 0.6.2

- ajout de deux méthodes pour encadrer la correction bidirectionnelle du rayonnement : hauteur minimale du soleil ou plage horaire configurable ;
- la correction positive vers `Ensoleillé` reste disponible pendant toute la plage générale d'analyse météo lorsque le seuil est dépassé ;
- la correction négative vers `Nuageux` n'est appliquée que si la hauteur solaire est suffisante ou pendant la plage horaire choisie ; en dehors, la prévision météo est conservée ;
- hauteur solaire minimale fixée à `15°` par défaut et plage horaire préremplie de `10:30` à `17:00` ;
- prise en charge des plages traversant minuit et diagnostic détaillé de l'autorisation courante de la correction basse.

## Version 0.6.1

- le rayonnement local devient prioritaire dans les deux sens : au-dessus du seuil il peut imposer `Ensoleillé`, et sous le seuil il impose `Nuageux` après le délai de maintien même si la couverture prévue reste faible ;
- une condition `Pluvieux` ou `Orageux avec pluie` explicitement cochée peut désormais être corrigée vers `Ensoleillé` par un rayonnement réellement élevé ; sous le seuil, son profil pluvieux initial est conservé ;
- ajout de ces conditions à la sélection de correction du panneau Météo et conservation correcte de leur état après enregistrement ;
- restauration du bouton ouvrant le menu latéral Home Assistant sur téléphone, sans modifier l'en-tête tablette ou ordinateur.

## Version 0.6.0

- nouvelle section météo **Seuil solaire utile** utilisant une entité de rayonnement en `W/m²` ou une entité d'éclairement en lux avec facteur de conversion configurable ;
- correction locale du profil `Nuageux` vers `Ensoleillé` après dépassement continu du seuil configuré ;
- délai de validation de 1 à 30 minutes et durée de maintien de 5 à 45 minutes afin d'absorber le passage d'un nuage sans changement immédiat de profil ;
- choix multiple des conditions météo pouvant être corrigées, limité aux conditions sans phénomène dangereux ; `Partiellement nuageux` et `Nuageux` sont sélectionnées par défaut ;
- priorité conservée aux précipitations, aux orages, à la grêle, à la neige et aux conditions exceptionnelles ;
- diagnostic enrichi avec le rayonnement converti, la valeur brute, l'état de la correction, le profil météo initial et la couverture effective ;
- traduction des mentions météo dans les associations françaises, anglaises et espagnoles, tout en conservant les identifiants techniques Home Assistant ;
- infobulles du planificateur complétées avec les puissances de charge/décharge et les limites SOC réellement enregistrées dans chaque créneau.

## Version 0.5.5

- ajout d'un seuil de précipitations configurable, fixé à `0,5 mm/h` par défaut ;
- une mention `rainy` située sous ce seuil n'impose plus le profil Pluvieux : la couverture nuageuse choisit alors le profil ;
- les phénomènes importants (`pouring`, `lightning-rainy`, grêle ou neige mêlée de pluie) conservent la priorité Pluvieux ;
- ajout des précipitations prévues, du seuil appliqué et de la raison détaillée dans le diagnostic météo ;
- conservation de la condition météo comme solution de secours lorsque la quantité de précipitations est absente.
- correction du menu de navigation sur téléphone : profil à gauche, roue dentée à droite et menu entièrement visible ;
- sections des commandes réelles Marstek et MQTT MS-A2 repliées par défaut ; leur état reste conservé pendant les actualisations automatiques de la vue d'ensemble.
- section « Consigne en cours » également repliable, avec l'heure de transmission placée à droite de la consigne pour économiser une ligne ;
- mémorisation locale et indépendante, pour chaque batterie, de l'ouverture des commandes réelles et de la consigne en cours : chaque navigateur et chaque appareil conserve ainsi sa propre disposition.

## Version 0.5.4

- centrage des libellés au-dessus des champs et sélecteurs dans toutes les sections de configuration, des interrupteurs sous leurs textes et des en-têtes des colonnes de paliers ;
- largeur du sélecteur de puissance réseau alignée sur la fin du libellé d'inversion du signe ;
- bouton de récupération des entités rapproché du sélecteur de batterie détectée et aligné sur celui-ci ; bilan sur la ligne suivante, aligné à droite sous le sélecteur ;
- interrupteurs de perte et de retour du Grid alignés à la même hauteur ; libellé des paliers « Charge maximum en Watt » ;
- sections renommées « Identification du type de batterie » et « Auto-configuration via Marstek Venus Modbus » ;
- libellés complets pour les compensations de charge/décharge et la retransmission des commandes ;
- bannière À propos centrée, numéro de version conservé sous l'image à droite.

## Version 0.5.3

- refonte visuelle de la configuration : couleurs bleu pétrole, contrôles arrondis et reliefs doux, avec adaptation aux écrans mobiles et au thème sombre ;
- illustrations du compteur réseau et des paliers de charge, actualisation des paliers après modification des seuils ;
- champ **Modèle** : Marstek Venus E 3.0, Hoymiles MS-A2 et Générique pour chaque marque ; image associée au modèle sélectionné ;
- conservation des réglages existants ; les batteries sans modèle renseigné restent en modèle Générique ; sélectionner un modèle ne modifie pas les paramètres de pilotage ;
- harmonisation de la détection Marstek Modbus, des commandes et des entités d'information (cinq colonnes sur grand écran) ;
- nouvelle bannière dans À propos, version affichée dessous à droite et lien corrigé vers https://www.logisub.com/battery-manager.html.

## Version 0.5.2

- ajout de la sécurité **Backup Marstek** : arrêt complet des commandes et verrouillage de la gestion rapide lorsque `Backup Function` est actif ;
- reprise automatique du mode précédent après désactivation du Backup et maintien d’une tension Grid comprise entre 200 et 250 V pendant 30 secondes ;
- ajout du mode rapide **Backup**, qui active le switch configuré sans remplacer le mode de fonctionnement précédent ;
- nouveau panneau **Actions** permettant de désactiver une entité à l’entrée en Backup et, facultativement, de restaurer son état initial après le retour du Grid ;
- mémorisation persistante de l’état initial de l’entité pendant les redémarrages de Home Assistant ;
- ajout d’une durée de réarmement des notifications, configurable en heures et mémorisée séparément pour chaque batterie et chaque destination ;
- durée de réarmement fixée par défaut à 14 heures pour les notifications de début de charge et de décharge ;
- journalisation unique des notifications inhibées pendant un même épisode ;
- ajout des panneaux **Actions** et **À propos** dans le menu principal ;
- ajout d’une documentation intégrée couvrant l’installation, la configuration, les modes, la planification, la météo, les protections, le Backup, les notifications, les journaux et le dépannage.

## Version 0.5.1

- estimation de l'heure d'atteinte du SOC maximal, actualisée chaque minute à partir d'une moyenne glissante et des paliers SOC ;
- colonne des journaux Consignes et Planificateur élargie ;
- conditions et motifs météo traduits dans le diagnostic et les journaux.

## Version 0.5.0

- panneau **Notifications** accessible par la roue dentée ;
- création, modification, test et suppression des cibles `notify.mobile_app_*` ;
- un créneau quotidien par cible, **07:00–22:00** par défaut, sans passage à minuit ;
- catalogue de 37 notifications, choix des batteries, seuils et destinataires ;
- seuils liés à Configuration lorsqu’une valeur correspondante existe, avec possibilité de personnaliser puis de rétablir le lien ;
- batteries cochées et destinataires décochés par défaut : aucun envoi sans sélection ;
- confirmation, réarmement et délai minimal entre alertes ;
- alertes persistantes envoyées à l’ouverture du créneau seulement si la condition est encore présente ;
- panneau **Journaux** avec Consignes, Planificateur, Gestion météo, Notifications et Actions utilisateurs ;
- historique persistant, **30 jours et 50 Mo au total**, suppression automatique des entrées les plus anciennes, recherche et pagination ;
- interface des nouveaux panneaux en français, anglais et espagnol.

## Version 0.4.9

- Correction du débordement des champs Début et Hystérésis dans le diagnostic météo sur les écrans étroits.
- Le bloc Interprétation passe désormais sur deux colonnes dès la largeur tablette.

## Version 0.4.8

- Les champs horaires Début et Fin du panneau Météo passent à 100 px.
- Le bouton de mise à jour météo est placé à gauche du bouton Enregistrer.
- Le diagnostic météo est présenté sur deux colonnes et quatre lignes afin de réduire sa hauteur.

## Version 0.4.7

- Les saisies numériques de l’interprétation météo, de la mesure réseau et des réglages généraux sont limitées à 80 px et alignées à gauche.
- Les libellés du zéro réseau, de l’hystérésis, de l’intervalle, des compensations et de la retransmission sont raccourcis pour réduire la hauteur des panneaux.
- Les champs qui nécessitent réellement de l’espace conservent leur largeur : entité réseau, nom, type de batterie et mode de retour à la désactivation.

## Version 0.4.6

- Barre supérieure compacte : le profil actif affiche directement `Automatique → profil` ou `Manuel → profil`, et une roue dentée regroupe la navigation.
- Le sélecteur de langue est déplacé dans la barre du panneau Configuration et l’onglet `Programmation` devient `Planificateur`.
- La vue d’ensemble est adaptée aux tablettes afin de conserver trois batteries sur une ligne, avec des en-têtes et des libellés énergétiques/BMS raccourcis.
- Les panneaux Météo et Configuration sont compactés pour limiter le défilement, sans modifier les sections de détection et d’entités Marstek.
- La légende et l’aide du Planificateur sont centrées, les champs SOC réduits et les tableaux de paliers recentrés.

## Version 0.4.5

- Ajout d’un bouton `Mettre à jour` dans le diagnostic météo pour forcer immédiatement une nouvelle prévision et une nouvelle lecture du capteur de couverture.
- Le rafraîchissement manuel fonctionne même lorsqu’un profil météo manuel est actif ; dans ce cas, il met à jour le diagnostic sans remplacer le profil global sélectionné.

## Version 0.4.4

- L’entité de couverture nuageuse configurée devient prioritaire sur la valeur éventuellement fournie par la prévision horaire.
- Les identifiants des entités météo sont nettoyés des espaces accidentels avant leur enregistrement.
- Le cache météo est invalidé après chaque enregistrement afin de relire immédiatement la couverture nuageuse.
- Le diagnostic météo indique maintenant la source de la couverture et la valeur brute reçue du capteur.

## Version 0.4.3

- Le bouton d'enregistrement du panneau Météo est aligné complètement à droite.
- Le bloc énergie de la vue d'ensemble utilise maintenant trois colonnes centrées avec le libellé au-dessus et la valeur avec son unité en dessous.
- Ajout des mesures Marstek `Cycle Count`, `Cycle Count (Calc)`, `Max Cell Voltage` et `Min Cell Voltage` sous une séparation dédiée.
- Les nouvelles mesures reprennent l'icône de leur entité Home Assistant et ouvrent leur historique au clic.
- Les quatre nouvelles entités sont détectées automatiquement depuis l'intégration Marstek Venus Modbus et restent sélectionnables dans la configuration.

## Version 0.4.2

- La vue d'ensemble affiche désormais l'énergie réellement stockée (`Stored Energy`) à la place de la capacité nominale fixe du pack.
- Les anciennes sélections `Battery Total Energy` sont automatiquement remplacées par `Stored Energy` lorsqu'elle est disponible sur le même appareil Marstek.
- Le SOC, la puissance, les mesures AC/DC, la température, l'état de l'onduleur, les commandes réelles et les compteurs d'énergie sont cliquables et ouvrent la fenêtre d'historique Home Assistant.
- La ligne énergie restante / chargé aujourd'hui / déchargé aujourd'hui utilise trois colonnes stables pour corriger les défauts d'alignement.

## Version 0.4.1

- Correction de la mise en page du panneau Météo et déplacement du bouton
  Enregistrer sous le titre.
- Remplacement des sélecteurs instables et des choix numériques par des menus
  à boutons compatibles avec les tablettes.
- Réinitialisation des puissances proposées selon la batterie et l'action.
- Recentrage des profils entre la barre d'édition et la légende.

## Version 0.4.0

- Nouveau planificateur hebdomadaire sur sept jours, affiché côte à côte pour
  les batteries et découpé en créneaux de 15 minutes.
- Trois profils météo fournis : Ensoleillé, Nuageux et Pluvieux, avec création
  de profils personnalisés et sélection globale manuelle ou automatique.
- Migration automatique de l'ancien planning journalier vers les trois profils
  sans perte de programmation.
- Nouveau panneau Météo utilisant les prévisions horaires Home Assistant à
  `+1 h`, la couverture nuageuse, une hystérésis configurable et la priorité
  aux précipitations.
- Sélection directe de plages par glisser-déposer, d'une journée, d'une heure
  sur toute la semaine ou de la semaine complète.
- Export et import JSON des seuls paramètres de planification.

## Version 0.3.4

- Ajout d'une flèche de tendance à gauche de la puissance réseau instantanée,
  calculée par rapport à la moyenne des quinze dernières minutes.
- Affichage séparé du mode actif du planificateur et de la commande réellement
  transmise.
- Déplacement de `User Work Mode` sous les puissances maximales Marstek.
- Séparation visuelle de l'état de l'onduleur.

## Version 0.3.3

- Masquage des mesures AC/DC, du rendement et de la température non disponibles
  pour les batteries Hoymiles MS-A2.
- Affichage vert des injections réseau et rouge des consommations, y compris
  pour les moyennes sur une et quinze minutes.
- Ajout d'un repère noir tous les 10 % sur l'anneau du SOC.

## Version 0.3.2

- Correction du faux statut `Hors ligne` lorsque le SOC et la puissance restent
  stables plus de deux minutes.
- Réorganisation du monitoring en deux colonnes cohérentes : AC à gauche et DC
  à droite.
- Ajout de l'icône de puissance devant `DC W`.

## Version 0.3.1

- Le rafraîchissement des entités ne reconstruit plus la vue tant que le menu
  rapide `Gestion` est ouvert ou possède le focus.
- Reconnaissance complétée des entités Venus Modbus `battery_total_energy`,
  `total_daily_charging_energy` et `total_daily_discharging_energy`.
- Les champs AC/DC restent disponibles pour une sélection manuelle dans
  `Configuration` > `Entités d'information` si une intégration emploie des
  identifiants différents.

## Version 0.3.0

- Refonte complète de la vue d'ensemble avec cercle de SOC, état de connexion,
  puissance et sens du flux, consigne active et monitoring AC/DC.
- Ajout du menu rapide `Gestion` par batterie : Planificateur, Charge,
  Autoconsommation collective, Autoconsommation native, Charge solaire,
  En attente et Désactivé.
- Un mode rapide remplace temporairement le planificateur sans modifier ses
  96 créneaux et reste enregistré après un redémarrage.
- Ajout des moyennes glissantes réseau sur une minute et quinze minutes, sans
  augmenter la hauteur du bandeau réseau.
- Ajout du rendement de conversion AC/DC, des températures minimale et maximale
  du jour, de l'état de l'onduleur et des compteurs de capacité/énergie lorsque
  les entités correspondantes sont disponibles.
- Les entités volontairement désactivées ne sont plus comptées comme des
  problèmes dans le diagnostic.
- Nouveaux paliers Marstek proposés par défaut : 0–85 % à 2500 W, 85–92 % à
  2000 W, 92–95 % à 1200 W et 95–100 % à 700 W.

## Version 0.2.26

- La détection automatique Marstek utilise désormais `ac_power`, côté réseau
  AC, au lieu de `battery_power`, côté batterie DC.
- Ajout de l'entité d'information `Tension Grid`, automatiquement associée à
  l'entité Marstek `ac_voltage`.
- Ajout du créneau blanc `Retour au mode par défaut`. Il applique le retour
  configuré pour la batterie pendant le créneau, puis le programme suivant
  reprend normalement le pilotage.
- Option de retour au mode par défaut après 60 secondes continues avec une
  tension Grid numérique hors de 200 à 250 V. Une valeur de 0 V est traitée
  comme une coupure ; `unknown`, `unavailable` ou une entité absente ne le sont
  jamais.
- Option de reprise automatique du pilotage au retour du Grid, uniquement si
  cette protection l'avait suspendu et dans un délai maximal de quatre heures.

## Version 0.2.25

- Les compensations sont désormais appliquées après les limites logiques des
  créneaux et des paliers SOC, sans être annulées lorsqu'une batterie atteint
  exactement son palier.
- Pour une Marstek, `Max Charge Power` inclut la compensation positive du
  palier actif. Exemple : palier 500 W et compensation +42 W donnent un maximum
  et une consigne de 542 W.
- La puissance maximale générale configurée reste la limite absolue.

## Version 0.2.24

- Ajout d'une compensation de charge et d'une compensation de décharge
  propres à chaque batterie, réglables de -200 à +200 W et initialisées à 0 W.
- La compensation est appliquée après la répartition collective et uniquement
  pour une commande active, sans dépasser le maximum général de la batterie.
- La vue d'ensemble distingue la consigne calculée, la compensation appliquée
  et la consigne effectivement transmise.

## Version 0.2.23

- Ajout du retour `Programmation native` pour Hoymiles MS-A2, envoyé par le
  mode MQTT `tou_plan`.
- Ajout des retours `Manuel` et `Optimisation IA` pour Marstek, correspondant
  aux valeurs User Work Mode `Manual` et `AI Optimization`.
- Le retour Hoymiles affiche désormais le dernier mode MQTT réellement envoyé :
  `mqtt_ctrl`, `general` ou `tou_plan`.
- Lors de la libération du pilotage Marstek, les maximums de charge et de
  décharge proviennent de la configuration de la batterie au lieu des anciennes
  valeurs fixes 2000/800 W.

## Version 0.2.22

- Une batterie bloquée par son SOC minimal ou maximal est maintenant exclue
  du calcul des parts collectives avant la répartition.
- Sa part est redistribuée entre les batteries encore disponibles au lieu
  d'être perdue sous la forme d'une consommation ou injection résiduelle.
- Lorsqu'une batterie atteint sa limite de puissance ou son palier de charge,
  le reliquat est également redistribué dans les limites des autres batteries.

## Version 0.2.21

- L'hystérésis est maintenant appliquée une seule fois à la cible
  collective. Les batteries sont actualisées ensemble, ce qui évite de
  cumuler 30 W d'erreur par batterie et synchronise les consignes identiques.
- Ajout d'une correction du zéro réseau comprise entre -200 et +200 W. La
  valeur saisie correspond à l'écart moyen observé sur le compteur.
- Centrage des mesures SOC, puissance, température et mode dans la vue
  d'ensemble. La puissance réseau est centrée et son identifiant masqué.

## Version 0.2.20

- Vérification des valeurs réelles `Max Charge Power` et
  `Max Discharge Power` à l'activation puis pendant le pilotage Marstek.
- Une directive de maximum n'est envoyée que si l'entité diffère de la limite
  effective configurée ; une valeur déjà correcte n'est pas réécrite.
- Le dernier palier de charge reste actif au-delà de sa borne haute, notamment
  lorsque le SOC remonte jusqu'à 100 %.

## Version 0.2.19

- Correction du protocole de commande Marstek d'après les essais réels :
  RS485 Control Mode est un mode maintenu et non une impulsion.
- En charge, décharge et Standby piloté, RS485 reste sur ON ; le gestionnaire
  utilise uniquement Force Mode et les consignes de puissance, sans imposer
  User Work Mode sur Manual.
- Pour rendre la main à l'autoconsommation native, le gestionnaire place Force
  Mode sur Standby, remet les consignes à zéro, passe RS485 sur OFF, puis
  sélectionne Self Consumption dans User Work Mode.

## Version 0.2.18

- Ajout d'un délai de retransmission propre à chaque batterie, réglé
  à 60 secondes par défaut. La valeur 0 désactive la retransmission
  périodique ; les changements d'action, de puissance et les protections
  restent immédiats.
- Ajout de l'action Charge solaire collective. Elle absorbe uniquement le
  surplus injecté vers le réseau, respecte les limites et paliers de SOC,
  et ne commande jamais de décharge en cas d'importation.
- L'heure de dernière publication correspond maintenant à une véritable
  commande, et non à chaque calcul de la boucle de contrôle.

## Version 0.2.17

- Ajout du retour configurable de la Hoymiles MS-A2 lors de la désactivation
  du pilotage : Standby à 0 W ou autoconsommation native via le mode EMS
  `general`.
- Les paliers de charge sont maintenant obligatoirement continus : à partir
  du deuxième palier, le SOC de début reprend automatiquement le SOC de fin du
  palier précédent. La validation côté serveur corrige aussi les anciennes
  configurations contenant des trous ou des chevauchements.
- Le bouton Enregistrer de la configuration est placé à droite de la barre
  Ajouter, Dupliquer et Supprimer.

## Version 0.2.16

- Correction du signe dans la régulation d'autoconsommation collective : la
  puissance déjà absorbée ou fournie par les batteries est maintenant
  retirée de la mesure réseau pour reconstruire le besoin réel avant
  batterie. Cela supprime la sous-estimation du surplus et les oscillations de
  consigne.

## Version 0.2.15

- Une batterie dont le pilotage est désactivé ne reçoit plus aucune
  commande au démarrage, au rechargement ou pendant la boucle périodique.
- Le retour Marstek choisi (Standby ou autoconsommation native) est maintenant
  envoyé une seule fois, uniquement lors du passage explicite de
  « Activation du pilotage » d'activé à désactivé.

## Version 0.2.14

- Correction du `NameError` sur `ACTION_STANDBY` lors de l'application du
  retour d'une Marstek désactivée.
- Le retour sélectionné est verrouillé avant l'envoi des commandes : une erreur
  survenant après une écriture ne peut plus relancer la séquence chaque seconde.

## Version 0.2.13

- Fusion de « Mode Programmation » et « Autoriser les commandes » en une seule
  case « Activation du pilotage ».
- Choix du retour d'une Marstek désactivée : Standby ou autoconsommation native.
- En retour natif, restauration de `Max Charge Power` à 2000 W et de
  `Max Discharge Power` à 800 W.
- Affichage de l'activation du pilotage et du retour sélectionné sous le statut.
- Compatibilité avec la valeur Marstek Modbus `anti_feed`, équivalente à
  l'autoconsommation native.

## Version 0.2.12

- Une erreur de commande sur une batterie est désormais isolée et ne peut plus
  interrompre le pilotage de toutes les batteries suivantes.
- Les valeurs envoyées aux entités `select` Marstek sont résolues parmi leurs
  options réelles, sans différence de casse ou de séparateurs.
- Une option Marstek réellement absente est journalisée puis ignorée au lieu de
  provoquer l'arrêt complet du contrôleur.

## Version 0.2.11

- Correction du statut « En attente » pour les anciennes batteries dont
  l'identifiant interne est vide : le nom est désormais utilisé comme secours.
- Affichage sous chaque action de la dernière consigne effectivement appliquée
  par le gestionnaire, de sa puissance et de l'heure de publication.
- Pour la MS-A2 : affichage de l'état batterie, des deux sujets MQTT, du dernier
  mode `mqtt_ctrl` et de la dernière puissance publiée.

## Version 0.2.10

- Ajout de la puissance réseau effective en haut de la vue d'ensemble, avec
  indication consommation/injection et prise en compte de l'inversion globale.
- Ajout des sept états de commande réellement lus sur chaque batterie Marstek
  afin de comparer la décision du gestionnaire avec les valeurs appliquées.

## Version 0.2.9

- L'option d'inversion de la puissance agit maintenant également sur la valeur
  affichée dans la vue d'ensemble.
- L'option est déplacée sous l'entité de puissance concernée afin d'éviter
  toute ambiguïté avec les commandes de la batterie.

## Version 0.2.8

- Ajout d'un SOC minimal et maximal pour chaque créneau de 15 minutes. Ces
  seuils ne peuvent jamais assouplir les protections globales de la batterie.
- En autoconsommation collective, sous le SOC minimal du créneau seule la
  charge reste possible ; au-dessus du SOC maximal seule la décharge reste
  possible.
- La protection des programmes fixes continue même si le capteur réseau est
  temporairement indisponible.
- Verrou final MS-A2 avant publication MQTT et consigne stricte `0.0` pour le
  standby ou l'atteinte du SOC minimal global.
- L'éditeur démarre sur `00:00`–`00:00` et conserve les valeurs saisies après
  l'application d'une plage ou le changement de batterie.

## Version 0.2.7

- `RS485 Control Mode` est désormais traité comme une impulsion de validation
  qui revient automatiquement à zéro, et non comme un interrupteur permanent.
- Modes forcés : écriture de `Manual`, du `Force Mode`, du `Set Power`, puis
  une seule impulsion RS485.
- Toute modification significative de `Set Charge Power` ou
  `Set Discharge Power` est validée par une nouvelle impulsion.
- Ajout d'une hystérésis de consigne configurable, fixée à 30 W par défaut.
- Le passage Charge/Décharge/Standby et les protections restent immédiats.
- Mode natif Marstek sans impulsion RS485, avec application directe de
  `Max Charge Power` et `Max Discharge Power` comme plafonds.

## Version 0.2.6

- Correction de la séquence Marstek lorsque RS485 est déjà actif : libération
  du contrôle, écriture de la puissance et des modes, puis réactivation.
- Compatibilité avec les états RS485 `on/off` et `1/0`, ainsi qu'avec les
  entités de type switch, number ou select.
- Passage fiable de `Self Consumption` vers `Manual + Force Mode` lors du
  retour en autoconsommation collective.
- Temporisation courte entre les écritures Modbus et absence de répétition
  lorsque la batterie est déjà dans l'état attendu.

## Version 0.2.5

- Détection automatique de l'entité Marstek `RS485 Control Mode`.
- Complément automatique des batteries Marstek déjà associées à un appareil ;
  un enregistrement du panneau suffit après la mise à jour.
- Séquence de commande Marstek validée : puissance, mode manuel, Force Mode,
  puis activation RS485.
- Ajout de l'action `Autoconsommation native Marstek`, distincte de
  l'autoconsommation collective calculée depuis le capteur réseau.
- Libération du contrôle RS485 lors du passage en mode natif ou de la
  désactivation de la gestion.
- Mémorisation des dernières commandes afin de ne pas réécrire les mêmes
  registres à chaque cycle, notamment avec un intervalle de contrôle d'une
  seconde.

## Version 0.2.4

- Interface complète disponible en français, anglais et espagnol.
- Sélection automatique selon la langue de Home Assistant ou choix manuel dans
  l'en-tête du panneau.
- Le choix manuel est mémorisé uniquement dans le navigateur utilisé.
- Traduction du panneau, de la configuration initiale, des diagnostics, des
  confirmations, des erreurs, des notifications et des motifs de décision.
- Les identifiants d'entités, sujets MQTT et valeurs techniques envoyées aux
  batteries restent inchangés.

## Version 0.2.3

- Alignement exact des libellés horaires et des 96 créneaux sur une grille
  commune.
- Suppression des marges cumulatives ajoutées au début de chaque heure.
- Largeur et espacement uniformes pour tous les créneaux et toutes les
  batteries.

## Version 0.2.2

- Affichage simultané des programmes journaliers de toutes les batteries.
- La batterie choisie dans la barre d'outils reste la cible de l'application
  d'une plage horaire.
- Valeurs par défaut adaptées au type : Générique 0/0 W, Marstek 2500/800 W,
  Hoymiles 1000/800 W.
- Chaque clic sur un créneau fait défiler Charge, Décharge,
  Autoconsommation et Standby avec les puissances adaptées.
- Libellés de puissance rendus plus explicites.

## Version 0.2.1

- Le diagnostic des entités conserve son état ouvert ou fermé pendant les
  actualisations des capteurs.
- Le titre du panneau affiche désormais `Gestionnaire de batteries` suivi de
  la version réellement chargée de l'interface.

## Version 0.2.0

- Détection automatique des appareils fournis par Marstek Venus Modbus depuis
  les registres d'appareils et d'entités de Home Assistant.
- Sélection d'une batterie Marstek puis remplissage automatique des entités de
  puissance, SOC, température, état et commandes.
- Diagnostic dépliable de toutes les entités rattachées à chaque batterie avec
  comptage des entités indisponibles, inconnues, désactivées ou non chargées.
- Affichage conditionnel des réglages Marstek et Hoymiles selon le type choisi.
- Ajout d'un numéro de version à l'URL du panneau pour éviter le cache du
  navigateur lors des mises à jour.

## Version 0.1.4

- Correction de l'ordre des décorateurs WebSocket selon l'implémentation de
  Home Assistant 2026.8 : `websocket_command`, puis `require_admin`, puis
  `async_response`.

## Version 0.1.3

- Correction de la sauvegarde sous Home Assistant 2026.8 : remplacement de
  l'ancienne vérification `connection.require_admin()` par le décorateur
  WebSocket `@websocket_api.require_admin`.

## Version 0.1.2

- Séparation des deux sélecteurs Marstek `User Work Mode` et `Force Mode`.
- Les valeurs de mode sont proposées depuis les options réelles des entités.
- Les erreurs d'enregistrement sont maintenant détaillées dans le panneau et
  dans le journal Home Assistant.

## Version 0.1.1

- Les identifiants d'entités se choisissent maintenant dans les sélecteurs natifs
  de Home Assistant, avec recherche et saisie personnalisée possible.
- Le bouton de suppression d'une batterie est maintenant visible dans la barre
  supérieure de la page Configuration.

## Limites connues — v0.5.5

- La qualité du profil automatique dépend de la précision et des données fournies par la source météo Home Assistant choisie.
- Les profils personnalisés sont sélectionnables manuellement ; l’association automatique avancée de ces profils reste à enrichir.
- La charge complète périodique pour l’équilibrage du BMS et la limitation thermique active ne sont pas encore disponibles.
- Les mesures AC/DC, le rendement, les compteurs d’énergie, les cycles et les tensions de cellules dépendent des entités exposées par chaque batterie.
- Les fonctions natives Marstek et le Backup nécessitent les entités de commande correspondantes.
- Le firmware ou le BMS peut imposer ses propres limites : la consigne envoyée peut différer de la puissance réellement acceptée par la batterie.
- L’intégration reste en bêta : vérifier le comportement réel du matériel avant d’autoriser le pilotage.

## Structure du dépôt — v0.5.5

```text
Battery-Manager/
├── .gitattributes
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   └── bug_report.yml
│   └── workflows/
│       └── validate.yml
├── .gitignore
├── LICENSE
├── README.md
├── SECURITY.md
├── custom_components/
│   └── battery_manager/
│       ├── __init__.py
│       ├── activity.py
│       ├── brand/
│       │   └── icon.png
│       ├── config_flow.py
│       ├── const.py
│       ├── controller.py
│       ├── discovery.py
│       ├── frontend/
│       │   ├── assets/
│       │   │   ├── battery-manager-banner.jpg
│       │   │   ├── hoymiles-ms-a2.jpg
│       │   │   └── marstek-venus-e3.svg
│       │   ├── battery-manager-panel.js
│       │   └── translations/
│       │       ├── en.json
│       │       ├── es.json
│       │       └── fr.json
│       ├── manifest.json
│       ├── model.py
│       ├── notification_rules.py
│       ├── notifications.py
│       ├── store.py
│       ├── strings.json
│       ├── translations/
│       │   ├── en.json
│       │   ├── es.json
│       │   └── fr.json
│       └── websocket.py
├── docs/
│   ├── CONFIGURATION.md
│   ├── HOYMILES_MQTT.md
│   └── INSTALLATION.md
├── hacs.json
└── tests/
    ├── run_checks.py
    └── test_model.py
```

Le dossier à installer dans Home Assistant est `custom_components/battery_manager/`.
Il doit être copié en entier, avec les sous-dossiers `brand`, `frontend/assets`,
`frontend/translations` et `translations`. Les dossiers `docs`, `tests` et `.github`
restent propres au dépôt et ne sont pas nécessaires à l’installation manuelle.
