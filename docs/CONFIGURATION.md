# Configuration détaillée

## Règle de sécurité pour les premiers essais

Ajoutez chaque batterie avec **Activation du pilotage désactivée**. Vérifiez
d'abord les mesures et les conventions de signe. N'activez les commandes
qu'après avoir testé manuellement les entités ou sujets correspondants avec une
puissance faible.

Battery Manager n'est pas une protection électrique. Les protections du BMS,
les disjoncteurs, les limites du constructeur et la conformité de
l'installation restent indispensables.

## Capteur global de puissance réseau

Choisissez le capteur qui mesure la puissance active totale échangée au point
de raccordement de la maison : compteur, Shelly, pince de mesure ou autre
équipement suffisamment réactif.

Convention attendue par défaut :

- valeur positive : importation depuis le réseau ;
- valeur négative : injection vers le réseau.

Activez **Inverser le capteur réseau** si votre compteur utilise la convention
opposée. Vérifiez cette convention en coupant temporairement la production puis
en allumant une charge connue. Le capteur doit devenir positif.

La **correction du zéro réseau** corrige un décalage moyen et constant. Laissez
la valeur à `0 W` tant qu'un écart répétable n'a pas été mesuré. La **zone
morte** évite les changements de commande autour de zéro et l'hystérésis évite
les réécritures pour de petites variations.

## Entités d'information de chaque batterie

| Champ | Contenu attendu | Obligatoire |
| --- | --- | --- |
| Puissance | Puissance instantanée de la batterie en W | Oui pour la régulation collective |
| Inverser la puissance | À activer si le signe réel est opposé à celui attendu | Selon le matériel |
| SOC | État de charge numérique entre 0 et 100 % | Oui |
| État | Mode ou état de fonctionnement affiché dans le panneau | Non |
| Température | Température de la batterie en °C | Non |
| Tension Grid | Tension AC d'entrée réseau de la batterie | Pour la protection perte Grid |

Pour identifier une entité, ouvrez **Outils de développement → États** et
recherchez le nom de la batterie, `power`, `soc`, `temperature`, `voltage` ou
`mode`. Comparez toujours la valeur affichée avec l'application constructeur.

## Convention de puissance de la batterie

Observez l'entité lorsque la batterie charge puis lorsqu'elle décharge. Activez
**Inverser la puissance** si nécessaire afin que Battery Manager interprète
correctement les flux. Une mauvaise convention de signe fausse la reconstruction
du besoin collectif et peut créer une régulation dans le mauvais sens.

## Limites et SOC

- **SOC minimal** : interdit la décharge à ce seuil.
- **Reprise de décharge** : SOC au-dessus duquel la décharge est de nouveau
  autorisée.
- **SOC maximal** : interdit la charge à ce seuil.
- **Reprise de charge** : SOC sous lequel la charge est de nouveau autorisée.
- **Charge/Décharge maximale** : limites absolues configurées pour la batterie.
- **Paliers de charge** : réduisent progressivement la puissance lorsque le SOC
  augmente. La limite appliquée est toujours la plus restrictive.

Les limites d'un créneau peuvent être plus strictes que les limites générales,
mais jamais les contourner.

## Programmation

La journée contient 96 créneaux de 15 minutes. Sélectionnez une batterie, une
heure de début et de fin, une action, les puissances maximales et les seuils SOC,
puis appliquez la plage.

- **Charge** : charge à la puissance demandée dans les limites configurées.
- **Décharge** : décharge à la puissance demandée.
- **Autoconsommation** : répartit collectivement charge ou décharge pour ramener
  l'échange réseau vers zéro.
- **Charge solaire collective** : absorbe uniquement le surplus solaire ; elle
  ne provoque aucune décharge.
- **Standby** : maintient la batterie sous contrôle avec une consigne nulle.
- **Retour au mode par défaut** : libère temporairement la batterie selon son
  comportement de retour configuré ; le créneau suivant peut reprendre le
  pilotage.
- **Autoconsommation native Marstek** : rend temporairement la régulation à la
  logique interne Marstek.

## Perte du Grid

Pour une Marstek, associez l'entité `ac_voltage` à **Tension Grid**. Si **Retour
au mode précédent si perte du Grid** est activé, une tension numérique restant
hors de 200 à 250 V pendant 60 secondes suspend le pilotage et applique le mode
de retour. Une valeur de `0 V` est considérée comme une coupure.

Une valeur `unknown`, `unavailable` ou une entité absente n'est volontairement
pas interprétée comme une coupure. L'option **Revenir automatiquement en
Programmation si retour du Grid** reprend le pilotage uniquement si cette
protection l'avait suspendu et si le retour survient dans un délai maximal de
quatre heures.

## Marstek par entités

Sélectionnez **Marstek** puis choisissez l'appareil détecté par l'intégration
Marstek Venus Modbus et utilisez **Récupérer les entités**. Contrôlez ensuite :

- `User Work Mode` ;
- `Force Mode` ;
- `RS485 Control Mode` ;
- consignes de charge et de décharge ;
- maximums de charge et de décharge ;
- puissance, SOC et tension Grid.

Les options réelles des sélecteurs sont reprises depuis Home Assistant. Ne
traduisez pas manuellement les valeurs techniques si l'appareil expose par
exemple `Manual`, `Charge`, `Discharge`, `Standby` ou `Self Consumption`.

## Hoymiles MS-A2

Les mesures de la MS-A2 sont choisies parmi les entités créées par sa passerelle
MQTT. Les commandes utilisent directement deux sujets MQTT : mode EMS et
consigne de puissance. Suivez le [guide Hoymiles MQTT](HOYMILES_MQTT.md) pour les
identifier et les tester.

## Validation avant activation

1. Vérifiez que toutes les mesures restent disponibles pendant plusieurs
   minutes.
2. Vérifiez les signes réseau et batterie.
3. Configurez des limites de puissance volontairement faibles.
4. Créez un court créneau de test.
5. Gardez l'application constructeur ouverte pour reprendre la main.
6. Activez le pilotage d'une seule batterie à la fois.
7. Contrôlez la consigne calculée, la consigne transmise et la mesure réelle.
8. N'ajoutez les autres batteries au pool qu'après validation du premier essai.

