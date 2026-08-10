// SOURCE seed — 20 Procedure Definitions, 50 Step Order Names, 400 Step
// Orders with interleaved lookups (SO[i] → PD[i mod 20] + SN[i mod 50]).
// Run ONCE on a clean org (03-reset-seeded first if re-seeding).
List<Procedure_Definition__c> pds = new List<Procedure_Definition__c>();
for (Integer i=0;i<20;i++) pds.add(new Procedure_Definition__c(Name='PD-'+String.valueOf(i).leftPad(3,'0')));
insert pds;
List<Step_Order_Name__c> sns = new List<Step_Order_Name__c>();
for (Integer i=0;i<50;i++) sns.add(new Step_Order_Name__c(Name='SN-'+String.valueOf(i).leftPad(3,'0')));
insert sns;
List<Step_Order__c> sos = new List<Step_Order__c>();
for (Integer i=0;i<400;i++) sos.add(new Step_Order__c(Name='SO-'+String.valueOf(i).leftPad(4,'0'), Procedure_Definition__c=pds[Math.mod(i,20)].Id, Step_Order_Name__c=sns[Math.mod(i,50)].Id));
insert sos;
