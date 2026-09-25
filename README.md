# Gestionnaire de batteries pour Home Assistant
[Site Web](https://logisub.com)

Première version bêta d'une intégration locale destinée à centraliser la
surveillance, la programmation et le pilotage de plusieurs batteries de
marques différentes.

### Planificateur journalier
[![Planificateur de Battery Manager](https://logisub.com/assets/bm-planificateur.jpg)](https://logisub.com/assets/bm-planificateur.jpg)

### Vue d’ensemble
[![Vue d’ensemble de Battery Manager](https://logisub.com/assets/bm-vue-ensemble.jpg)](https://logisub.com/assets/bm-vue-ensemble.jpg)

### Configuration générale
[![Configuration générale de Battery Manager](https://logisub.com/assets/bm-configuration-generale.jpg)](https://logisub.com/assets/bm-configuration-generale.jpg)

### Protections et paliers de charge
[![Protections et paliers de charge](https://logisub.com/assets/bm-configuration-paliers.jpg)](https://logisub.com/assets/bm-configuration-paliers.jpg)

> **Important :** Battery Manager est une intégration personnalisée Home
> Assistant installable avec HACS ou manuellement. Ce n'est pas un module
> complémentaire du Home Assistant Add-on Store.

## Documentation

- [Présentation de Battery Manager sur LogiSub](https://logisub.com/battery-manager.html#installation)
- [Installation avec HACS ou installation manuelle](docs/INSTALLATION.md)
- [Configuration détaillée et choix des entités](docs/CONFIGURATION.md)
- [Guide Hoymiles MS-A2 et identification des sujets MQTT](docs/HOYMILES_MQTT.md)
- [Ouverture d'un rapport de problème](https://github.com/RenaudSub/Battery-Manager/issues)

## Fonctionnalités présentes

- panneau `Gestion batteries` dans la barre latérale ;
- ajout de plusieurs batteries ;
- adaptateurs `Marstek par entités`, `Hoymiles MS-A2 MQTT` et surveillance seule ;
- programme journalier de 96 créneaux de 15 minutes ;
- actions Charge, Décharge, Autoconsommation et Standby ;
- puissance de charge et de décharge par créneau ;
- SOC minimal et maximal avec seuils de reprise ;
- limites matérielles de puissance par batterie ;
- jusqu'à huit paliers de charge selon le SOC (quatre proposés par défaut) ;
- zone morte configurable pour l'autoconsommation ;
- arrêt du calcul si le capteur réseau ou le SOC est indisponible ;
- maintien du contrôle MQTT de la MS-A2 par publication périodique.

## Avertissement bêta

La gestion réelle est **désactivée par défaut** pour chaque batterie. Commencez
en surveillance seule et vérifiez les noms des modes, le signe des puissances,
les limites et les réactions du matériel avant d'autoriser les commandes.

Cette intégration n'est pas un dispositif de sécurité électrique et ne remplace
pas les protections du BMS, les disjoncteurs ou les limites du constructeur.

## ⚠️ Avertissement concernant le firmware Marstek V150

Depuis l’installation du firmware V150 sur des Marstek Venus E, un comportement anormal a été observé dans certains modes de fonctionnement.

Sur l’installation testée :
   - la charge en mode autoconsommation semble limitée à environ 700 W 
   - la décharge semble plafonnée à environ 1 000 W 
   - la valeur Max Charge Power peut être modifiée ou limitée par la batterie en fonction du mode ou du SOC 

la charge solaire collective pilotée directement par Battery Manager peut continuer à fonctionner à une puissance supérieure.

Ces limitations semblent provenir du firmware Marstek V150 et non du calcul de répartition de Battery Manager. Elles peuvent néanmoins modifier les puissances réellement appliquées par rapport aux consignes envoyées.

Ce comportement n’est pas encore confirmé sur toutes les batteries ni toutes les installations. Les utilisateurs du firmware V150 sont invités à vérifier dans Home Assistant les valeurs réelles de Max Charge Power, Max Discharge Power et la puissance mesurée par la batterie.

Si vous observez le même problème, merci d’indiquer dans une issue GitHub :
   - le modèle exact de la batterie.
   - la version du firmware.
   - le mode utilisé.
   - le SOC.
   - la consigne envoyée.
   - la puissance réellement mesurée.
     
En attendant une réponse de Marstek, commencez les essais avec une puissance réduite et gardez l’application constructeur disponible pour reprendre la main.

## Installation manuelle

1. Copier `custom_components/battery_manager` dans le dossier
   `/config/custom_components/` de Home Assistant.
2. Redémarrer Home Assistant.
3. Ouvrir **Paramètres → Appareils et services → Ajouter une intégration**.
4. Rechercher **Gestionnaire collectif de batteries**.
5. Sélectionner le capteur global de puissance réseau.
6. Ouvrir le nouveau panneau **Gestion batteries** dans la barre latérale.

Pour une installation avec HACS, les mises à jour et le dépannage, consultez
le [guide d'installation complet](docs/INSTALLATION.md).

## Convention du capteur réseau

Par défaut :

- valeur positive : importation depuis EDF ;
- valeur négative : injection vers EDF.

L'option d'inversion permet d'utiliser un capteur ayant la convention opposée.

## Hoymiles MS-A2

Exemple avec le numéro de série fictif `XXXXXXXXXXXX` :

```text
Sujet mode EMS
homeassistant/select/MSA-XXXXXXXXXXXX/ems_mode/command

Sujet consigne
homeassistant/number/MSA-XXXXXXXXXXXX/power_ctrl/set
```

Convention utilisée par la MS-A2 :

- puissance négative : charge ;
- puissance positive : décharge.

L'intégration envoie `mqtt_ctrl` puis renouvelle la consigne. Une alternance de
0,1 W est volontaire afin d'éviter le retour automatique à la logique interne.

La procédure complète pour écouter le broker, retrouver ces deux sujets et
effectuer un essai sans activer le gestionnaire est disponible dans le
[guide Hoymiles MS-A2](docs/HOYMILES_MQTT.md).

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

## Limites connues de la version 0.2.26

- un seul programme journalier, répété tous les jours ;
- pas encore de profils hebdomadaires Été/Hiver/Absence ;
- pas encore de charge complète périodique pour équilibrage du BMS ;
- pas encore de limite thermique active ;
- interface et moteur encore en phase bêta : commencez en surveillance seule et
  contrôlez chaque commande sur votre propre installation.

## Structure

```text
custom_components/battery_manager/
├── __init__.py
├── config_flow.py
├── const.py
├── controller.py
├── manifest.json
├── model.py
├── store.py
├── websocket.py
└── frontend/battery-manager-panel.js
```
