export interface SMSProvider {
  sendSMS(to: string, message: string): Promise<any>;
}
