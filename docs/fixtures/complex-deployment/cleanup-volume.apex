// SFTK volume fixture — remove up to 9,000 volume Accounts per run (contacts
// and opportunities cascade). Run until the count is 0.
List<Account> accs = [SELECT Id FROM Account WHERE Name LIKE 'SFTK VOL Account %' LIMIT 9000];
Database.delete(accs, false);
System.debug('SFTK VOL removed ' + accs.size());
