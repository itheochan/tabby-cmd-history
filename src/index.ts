import { NgModule } from '@angular/core'
import { ConfigProvider } from 'tabby-core'
import { CommandHistoryConfigProvider } from './config/configProvider'

@NgModule({
    providers: [
        { provide: ConfigProvider, useClass: CommandHistoryConfigProvider, multi: true },
    ],
})
export default class CommandHistoryModule {}
