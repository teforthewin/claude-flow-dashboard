import { app } from 'electron';
import { Settings as CoreSettings } from '../core/Settings';

export type { AppSettings } from '../core/Settings';

export class Settings extends CoreSettings {
  constructor() {
    super(app.getPath('userData'));
  }
}
