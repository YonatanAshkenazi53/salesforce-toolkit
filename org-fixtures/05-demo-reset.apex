// DEMO RESET — run in the TARGET org (ashkenazy7). One paste: removes all
// fixture garbage (impostors + duplicate SO-0100), then plants FRESH
// divergence so the reconcile demo shows every bucket + every warning.
// Prereq: orgs previously aligned. For the SOURCE org run 06 instead.
delete [SELECT Id FROM Step_Order__c WHERE Name LIKE 'SO-9%'];
List<Step_Order__c> dups = [SELECT Id FROM Step_Order__c WHERE Name = 'SO-0100' ORDER BY CreatedDate ASC];
List<Step_Order__c> extraDel = new List<Step_Order__c>();
for (Integer i = 1; i < dups.size(); i++) extraDel.add(dups[i]);
delete extraDel;
List<Step_Order__c> sos = [SELECT Id, Name, Procedure_Definition__c, Step_Order_Name__c FROM Step_Order__c WHERE Name LIKE 'SO-%' ORDER BY Name];
List<Step_Order_Name__c> sns = [SELECT Id FROM Step_Order_Name__c WHERE Name LIKE 'SN-%' ORDER BY Name];
List<Step_Order__c> upd = new List<Step_Order__c>();
for (Integer i = 0; i < sos.size(); i++) if (Math.mod(i, 7) == 0) { sos[i].Step_Order_Name__c = sns[Math.mod(i + 3, sns.size())].Id; upd.add(sos[i]); }
update upd;
List<Step_Order__c> dels = new List<Step_Order__c>();
for (Integer i = 40; i < 70; i++) dels.add(sos[i]);
delete dels;
List<Step_Order__c> extras = new List<Step_Order__c>();
for (Integer i = 0; i < 20; i++) extras.add(new Step_Order__c(Name = 'SO-9' + String.valueOf(i).leftPad(2, '0'), Procedure_Definition__c = sos[0].Procedure_Definition__c, Step_Order_Name__c = sns[0].Id));
insert extras;
insert new Step_Order__c(Name = 'SO-0100', Procedure_Definition__c = sos[0].Procedure_Definition__c, Step_Order_Name__c = sns[0].Id);
