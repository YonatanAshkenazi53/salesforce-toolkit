List<Account> accs = new List<Account>();
for (Integer i = 1; i <= 5; i++) accs.add(new Account(Name = 'SFTK PK Account ' + i, SFTK_FC_Test_Status__c = 'Closed'));
for (Integer i = 6; i <= 8; i++) accs.add(new Account(Name = 'SFTK PK Account ' + i, SFTK_FC_Test_Status__c = 'Reviewed'));
Database.DMLOptions dmo = new Database.DMLOptions(); dmo.duplicateRuleHeader.allowSave = true;
for (Account a : accs) a.setOptions(dmo);
Database.insert(accs, false);
System.debug('seeded ' + [SELECT COUNT() FROM Account WHERE Name LIKE 'SFTK PK Account %']);
