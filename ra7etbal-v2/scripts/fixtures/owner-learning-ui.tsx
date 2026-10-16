import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import SettingsModal from '../../src/components/settings/SettingsModal';
import { supabase } from '../../src/lib/supabase';
import { useProfileStore } from '../../src/stores/profile';
import * as learning from '../../src/lib/carson-persistent-memory';
import '../../src/styles/globals.css';
const owner='46400000-0000-4000-8000-000000000001';
const tokens=await fetch('http://127.0.0.1:4064/__fixture/session').then(r=>r.json());
await supabase.auth.setSession(tokens);
useProfileStore.setState({status:'ready',loadedForUserId:owner,displayName:'Local owner'});
(window as any).learningFixture={
  teach: (text:string)=>learning.savePersistentInstruction('preference',text),
  list: learning.listOwnerInstructions,
  context: learning.loadPersistentMemory,
  createConflict: async () => {
    const [row] = await learning.listOwnerInstructions();
    const { error } = await supabase.from('carson_persistent_memory').insert([
      {category:`${row.category.split("/after/")[0]}/after/${row.id}`,instruction:'Offer four travel options.',source:'owner_directive'},
      {category:`${row.category.split("/after/")[0]}/after/${row.id}`,instruction:'Offer six travel options.',source:'owner_directive'},
    ]);
    if (error) throw error;
  },
  reset: ()=>supabase.from('carson_persistent_memory').delete().neq('id','00000000-0000-0000-0000-000000000000'),
};
function App(){const [open,setOpen]=useState(true);return <MemoryRouter><button onClick={()=>setOpen(true)}>Open Settings</button><SettingsModal open={open} onClose={()=>setOpen(false)} userId={owner}/></MemoryRouter>;}
createRoot(document.getElementById('root')!).render(<App/>);
