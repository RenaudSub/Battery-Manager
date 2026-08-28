# Hoymiles MS-A2 : entités et sujets MQTT

Ce guide concerne une MS-A2 dont la passerelle ou l'application MQTT publie les
données dans le broker utilisé par Home Assistant. Battery Manager ne découvre
pas automatiquement les deux sujets de commande : il faut les identifier puis
les copier dans la configuration de la batterie.

## Prérequis

- la MS-A2 doit déjà publier sur le broker MQTT ;
- l'intégration **MQTT** doit être configurée et connectée dans Home Assistant ;
- les entités de la MS-A2 doivent idéalement être visibles sous **Paramètres →
  Appareils et services → MQTT** ;
- le pilotage Battery Manager doit rester désactivé pendant l'identification.

Ne publiez jamais sur un sujet inconnu avec une puissance élevée. Un sujet de
commande agit réellement sur la batterie.

## Méthode 1 — écouter depuis Home Assistant

1. Ouvrez **Paramètres → Appareils et services**.
2. Ouvrez l'intégration **MQTT** ou **Mosquitto broker**.
3. Cliquez sur **Configurer**.
4. Dans **Écouter un sujet**, commencez par saisir :

   ```text
   homeassistant/#
   ```

5. Cliquez sur **Démarrer l'écoute**.
6. Dans l'application ou l'interface Hoymiles, modifiez une seule fois le mode
   EMS ou la puissance afin de provoquer un message identifiable.
7. Recherchez dans les messages un chemin contenant `MSA-`, `ems_mode` ou
   `power_ctrl`.

Le joker `#` signifie « tous les sous-sujets ». Si le volume est trop important,
réduisez progressivement l'écoute :

```text
homeassistant/select/#
homeassistant/number/#
homeassistant/+/MSA-XXXXXXXXXXXX/#
```

Remplacez `XXXXXXXXXXXX` par le numéro présent dans **vos propres sujets**. Ne
publiez pas ce numéro de série dans un rapport GitHub.

## Sujets généralement utilisés

Avec la convention de découverte MQTT courante, les deux sujets ressemblent à :

```text
homeassistant/select/MSA-XXXXXXXXXXXX/ems_mode/command
homeassistant/number/MSA-XXXXXXXXXXXX/power_ctrl/set
```

Le premier est le **Sujet mode EMS** et le second le **Sujet consigne** à copier
dans Battery Manager. Il faut utiliser les sujets de commande `/command` et
`/set`, pas les sujets d'état.

Ne recopiez pas aveuglément ces exemples : le préfixe MQTT, l'identifiant de
l'appareil ou l'organisation des sujets peuvent différer selon la passerelle.

## Retrouver les sujets depuis MQTT Discovery

Si les sujets de commande ne sont pas évidents, écoutez les messages de
découverte conservés par le broker :

```text
homeassistant/select/+/ems_mode/config
homeassistant/number/+/power_ctrl/config
```

Le contenu JSON comporte normalement des champs tels que `command_topic`,
`state_topic`, `name` et `unique_id`. La valeur de `command_topic` est celle à
copier dans Battery Manager.

Exemple simplifié pour le mode :

```json
{
  "name": "EMS mode",
  "command_topic": "homeassistant/select/MSA-XXXXXXXXXXXX/ems_mode/command",
  "state_topic": "homeassistant/select/MSA-XXXXXXXXXXXX/ems_mode/state"
}
```

Exemple simplifié pour la puissance :

```json
{
  "name": "Power control",
  "command_topic": "homeassistant/number/MSA-XXXXXXXXXXXX/power_ctrl/set",
  "state_topic": "homeassistant/number/MSA-XXXXXXXXXXXX/power_ctrl/state"
}
```

## Méthode 2 — ligne de commande Mosquitto

Depuis une machine autorisée à joindre le broker :

```bash
mosquitto_sub -h ADRESSE_DU_BROKER -p 1883 -u UTILISATEUR -P MOT_DE_PASSE -v -t 'homeassistant/#'
```

Pour limiter la sortie aux sujets probablement utiles :

```bash
mosquitto_sub -h ADRESSE_DU_BROKER -p 1883 -u UTILISATEUR -P MOT_DE_PASSE -v -t 'homeassistant/select/+/ems_mode/#' -t 'homeassistant/number/+/power_ctrl/#'
```

La commande avec `-P` peut laisser le mot de passe dans l'historique ou la
liste des processus. Préférez l'écoute intégrée à Home Assistant, un fichier de
configuration Mosquitto protégé, ou supprimez ensuite la commande de
l'historique du shell.

## Entités d'information à sélectionner

Dans Battery Manager, les champs d'information ne reçoivent pas des sujets
MQTT mais des **identifiants d'entités Home Assistant** déjà créés par MQTT
Discovery.

| Champ Battery Manager | Donnée recherchée | Exemple de mot-clé |
| --- | --- | --- |
| Puissance | puissance instantanée de la batterie | `bat_p`, `battery_power` |
| SOC | charge restante en pourcentage | `soc` |
| État | état ou mode de la batterie | `bat_sts`, `ems_mode` |
| Température | température BMS ou batterie | `temperature`, `heat` |

Ouvrez **Outils de développement → États**, recherchez `MSA`, puis observez les
valeurs pendant une charge et une décharge. Utilisez l'entité dont la valeur et
l'unité correspondent réellement à l'application Hoymiles.

## Convention de commande MS-A2

Battery Manager utilise la convention suivante pour `power_ctrl` :

- valeur négative : charge ;
- valeur positive : décharge ;
- `0` : aucune puissance demandée.

Pendant le pilotage, le gestionnaire publie d'abord `mqtt_ctrl` sur le sujet du
mode EMS, puis la consigne sur le sujet de puissance. Il renouvelle la commande
selon le délai configuré. Une très petite alternance autour de la consigne peut
être utilisée pour empêcher le firmware de reprendre automatiquement sa logique
interne.

À la désactivation, le comportement choisi peut envoyer :

- `mqtt_ctrl` avec une consigne de `0` pour Standby ;
- `general` pour l'autoconsommation native ;
- `tou_plan` pour la programmation native.

## Test manuel prudent

Le test peut être réalisé depuis la zone **Publier un paquet** de la
configuration MQTT. Battery Manager doit rester désactivé.

1. Publiez `mqtt_ctrl` sur le sujet du mode EMS, sans rétention.
2. Publiez une consigne très faible et compatible avec votre matériel, par
   exemple `50`, sur le sujet `power_ctrl/set`, sans rétention.
3. Vérifiez immédiatement l'application Hoymiles, la puissance mesurée et le
   sens du flux.
4. Publiez `0` pour arrêter le test.
5. Publiez `general` ou `tou_plan` si vous souhaitez rendre la main à la logique
   native correspondante.

N'utilisez pas le bouton de publication si vous ne savez pas avec certitude
quel sujet vous ciblez. Ne laissez jamais une consigne de test sans surveillance.

## Diagnostic

- **Aucun message n'apparaît :** écoutez temporairement `#`, vérifiez le broker,
  le préfixe configuré dans la passerelle et la connexion MQTT de Home Assistant.
- **Les entités existent mais pas les sujets de commande :** écoutez les sujets
  `config` de MQTT Discovery et recherchez `command_topic`.
- **La commande n'agit pas :** vérifiez que `mqtt_ctrl` a été envoyé avant la
  puissance, que le sujet exact finit par `/set`, et que la passerelle accepte
  les commandes.
- **Le sens est inversé :** arrêtez immédiatement avec `0` et vérifiez la
  convention de votre firmware avant d'utiliser Battery Manager.
- **La batterie reprend son mode interne :** contrôlez le délai de
  retransmission et les messages réellement publiés dans la vue d'ensemble.
- **L'état reste `unknown` après un redémarrage :** attendez une nouvelle
  publication ou vérifiez si les messages d'état sont conservés par le broker.

