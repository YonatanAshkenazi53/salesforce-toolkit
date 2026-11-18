import { LightningElement, api } from 'lwc';
// Admin Toolkit fixture: the field is named as text only (no @salesforce/schema import).
export default class SftkKindText extends LightningElement {
    @api recordId;
    fields = ['SFTK_Kind__c.Tag__c'];
}
