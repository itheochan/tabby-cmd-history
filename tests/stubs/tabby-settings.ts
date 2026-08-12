export abstract class SettingsTabProvider {
    abstract id: string
    abstract icon: string
    abstract title: string
    abstract weight: number
    prioritized = false
    abstract getComponentType (): unknown
}
