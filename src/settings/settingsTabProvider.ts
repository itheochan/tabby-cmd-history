import { SettingsTabProvider } from 'tabby-settings'
import { CommandHistorySettingsTabComponent } from './settingsTab.component'

export class CommandHistorySettingsTabProvider extends SettingsTabProvider {
    id = 'cmd-history'
    icon = 'fas fa-history'
    title = 'Command history'
    weight = 20
    prioritized = false

    getComponentType (): typeof CommandHistorySettingsTabComponent {
        return CommandHistorySettingsTabComponent
    }
}
